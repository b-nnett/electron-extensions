import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from '../lib/cdp.mjs';
import { MainInspectorRenderer } from '../lib/main-inspector-renderer.mjs';
import { RendererScriptController } from '../lib/renderer-script-controller.mjs';
import { CLAUDE_APP_KEY, CLAUDE_BUNDLE, CLAUDE_EXECUTABLE, CLAUDE_PAGE, CLAUDE_SETUP,
  readClaudeExtensions, parseClaudeRegistry, InspectorRendererStylesheet } from '../lib/claude-extensions.mjs';
import { ExtensionSessionLogFile, rendererStateProof, recoverableExtensionFailure } from '../lib/extension-session-logs.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../lib/process-identity.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';
import { chatGPTOutputDirectory } from './dock-chatgpt-session.mjs';
import { appendCatalogRevision, sampleCatalogSurvival, catalogTerminalStatus, applyCatalogSources } from './dock-catalog-session.mjs';

const exec = promisify(execFile), now = () => new Date().toISOString();
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export function parseClaudeOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!['--library', '--output'].includes(key) || options[key.slice(2)] || typeof value !== 'string' ||
        !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Use --library <absolute JSON> --output <new absolute session directory>. Claude has no debugger or target override.');
    options[key.slice(2)] = path.normalize(value);
  }
  if (!options.library || !options.output) throw new Error('Both --library and --output are required.');
  return options;
}
export function claudeInspectorListener(stdout, pid) {
  const pids = [...stdout.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1]));
  const addresses = [...stdout.matchAll(/^n(.+)$/gm)].map(match => match[1]);
  return pids.length === 1 && pids[0] === pid && addresses.length === 1 && addresses[0] === '127.0.0.1:9229';
}
export function claudeInspectorEndpoint(targets) {
  if (!Array.isArray(targets) || targets.length !== 1 || targets[0]?.type !== 'node') throw new Error('Claude did not expose exactly one main-process inspector.');
  const url = new URL(targets[0].webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.host !== '127.0.0.1:9229' || url.username || url.password || url.search || url.hash ||
      !/^\/[0-9a-f-]{36}$/i.test(url.pathname)) throw new Error('The main-process endpoint is outside the fixed Claude inspector.');
  return url.href;
}
async function registry() {
  const script = "ObjC.import('AppKit');var apps=$.NSWorkspace.sharedWorkspace.runningApplications;var result=[];for(var i=0;i<apps.count;i++){var a=apps.objectAtIndex(i);var id=ObjC.unwrap(a.bundleIdentifier),p=ObjC.unwrap(a.bundleURL.path);if(id==='com.anthropic.claudefordesktop'||p==='/Applications/Claude.app')result.push({pid:Number(a.processIdentifier),bundleIdentifier:id,bundlePath:p});}JSON.stringify(result);";
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000, maxBuffer: 65536 });
  return parseClaudeRegistry(JSON.parse(stdout));
}
async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
async function inspectorTargets() {
  const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('The main-process inspector metadata is unavailable.');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength; if (bytes > 65536) throw new Error('Inspector metadata exceeded 64 KiB.');
      chunks.push(item.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function runClaudeDock(supplied) {
  const options = parseClaudeOptions(['--library', supplied.library, '--output', supplied.output]);
  const output = await chatGPTOutputDirectory(options.output);
  const basename = path.basename(output), sessionID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(basename) ? basename : randomUUID();
  const report = { appKey: CLAUDE_APP_KEY, bundle: CLAUDE_BUNDLE, sessionID, brokerPid: process.pid, startedAt: now(),
    scope: 'User-enabled Claude main inspector relays fixed renderer CDP commands. Imported source executes only in the isolated renderer world on https://claude.ai/new; no bypass flags, private preferences, target bundle changes or automatic debugger activation.',
    setup: { manualEachLaunch: true, performedByBroker: false }, revisions: [], revisionCount: 0, droppedRevisions: 0, errors: [], cleanup: {}, launchOwnership: 'none' };
  let status = { appKey: CLAUDE_APP_KEY, bundle: CLAUDE_BUNDLE, sessionID, brokerPid: process.pid, phase: 'starting',
    startedAt: report.startedAt, phaseStartedAt: report.startedAt, heartbeatVersion: 1, pid: null, port: null, revision: 0, jsStates: [] };
  const logs = new ExtensionSessionLogFile(path.join(output, 'extension-logs.json'), sessionID, { appKey: CLAUDE_APP_KEY });
  let identity, inspector, page, styles, scripts, before, stopped, originalEnded = false, lastRevision, pendingJS;
  const stop = reason => { stopped ??= reason; };
  const signal = () => stop('controller-stopped');
  const recordError = error => { if (report.errors.length < 16) report.errors.push(String(error?.message ?? error).slice(0, 1000)); };
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  async function publish(update = {}, heartbeatOnly = false) {
    try { await logs.flush(); }
    catch { recordError('Extension log persistence failed.'); stop('extension-log-error'); update = { ...update, phase: 'error', error: 'Extension log persistence failed.' }; }
    const timestamp = now();
    if (update.phase && update.phase !== status.phase) status.phaseStartedAt = timestamp;
    status = { ...status, ...update, updatedAt: timestamp, heartbeatAt: timestamp };
    if (!heartbeatOnly) await atomicJSON(path.join(output, 'report.json'), report);
    await atomicJSON(path.join(output, 'status.json'), status);
  }
  async function requireProcess() {
    if (!identity || originalEnded) throw new Error('The selected Claude process ended.');
    const current = await getProcessIdentity(identity.pid);
    if (current === null || (current?.pid === identity.pid && current.started !== identity.started)) {
      originalEnded = true; stop('app-exited'); throw new Error('The original Claude process ended or its PID was reused.');
    }
    if (!sameProcessIdentity(identity, current)) throw new Error('Claude process ownership changed.');
  }
  async function hasInspector() {
    await requireProcess();
    let stdout;
    try { ({ stdout } = await exec('/usr/sbin/lsof', ['-nP', '-iTCP:9229', '-sTCP:LISTEN', '-Fpn'], { timeout: 5000, maxBuffer: 65536 })); }
    catch (error) { if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return false; throw error; }
    if (!claudeInspectorListener(stdout, identity.pid)) throw new Error('Port 9229 is not owned exclusively by this Claude process on IPv4 loopback.');
    return true;
  }
  async function requireOwner() {
    if (!await hasInspector()) throw new Error('Claude’s user-enabled main-process debugger is no longer available.');
  }
  try {
    await publish();
    if (!(await readClaudeExtensions(options.library)).hasContent) throw new Error('No enabled Claude extension content is available. Open Claude normally.');
    if (await realpath(CLAUDE_EXECUTABLE) !== CLAUDE_EXECUTABLE) throw new Error('Claude is not installed at its fixed executable path.');
    const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', `${CLAUDE_BUNDLE}/Contents/Info.plist`]);
    const info = JSON.parse(stdout);
    if (info.CFBundleIdentifier !== CLAUDE_APP_KEY) throw new Error('The installed Claude bundle identity changed.');
    report.appVersion = info.CFBundleShortVersionString; report.appBuild = info.CFBundleVersion;
    before = await inspectIntegrity(CLAUDE_BUNDLE); report.before = before;
    let application = await registry();
    if (!application && !stopped) {
      if (!(await readClaudeExtensions(options.library)).hasContent) throw new Error('Claude extensions were disabled before launch; no app was opened.');
      report.launchOwnership = 'normal-launch-requested';
      await exec('/usr/bin/open', ['-a', CLAUDE_BUNDLE], { timeout: 10000 });
      for (let attempt = 0; !application && !stopped && attempt < 100; attempt++) { await wait(100); application = await registry(); }
    } else if (application) report.launchOwnership = 'adopted';
    if (stopped) return report;
    if (!application) throw new Error('Claude did not register a unique normal app process.');
    identity = await getProcessIdentity(application.pid);
    if (identity?.executable !== CLAUDE_EXECUTABLE || identity.uid !== process.getuid()) throw new Error('Claude’s kernel process identity does not match the installed app.');
    report.processIdentity = identity;
    await publish({ phase: 'waiting-for-debugger', pid: identity.pid, processIdentity: identity, setupMessage: CLAUDE_SETUP });
    while (!stopped && !await hasInspector()) { await publish({}, true); await wait(1000); }
    if (stopped) return report;
    const endpoint = claudeInspectorEndpoint(await inspectorTargets());
    await requireOwner();
    inspector = new CDP(endpoint, 15000); await inspector.ready;
    inspector.on('disconnected', () => stop('debugger-disconnected'));
    page = new MainInspectorRenderer({ inspector, requireOwner });
    page.on('failure', error => { recordError(error); stop('renderer-bridge-failure'); });
    page.on('disconnected', () => stop('renderer-debugger-detached'));
    await page.prepare();
    await publish({ phase: 'waiting-for-page', port: 9229, setupMessage: 'Open a new chat in Claude (https://claude.ai/new). Close that window’s DevTools if they are attached.' });
    let selected;
    while (!stopped) {
      selected = await page.discover();
      if (selected?.ready && !selected.debuggerAttached) break;
      await publish({}, true); await wait(1000);
    }
    if (stopped) return report;
    compareIntegrity(before, await inspectIntegrity(CLAUDE_BUNDLE));
    await page.attach(selected.id); report.renderer = { id: selected.id, url: CLAUDE_PAGE, transport: 'main-inspector-to-renderer-cdp' };
    styles = new InspectorRendererStylesheet(page, url => url === CLAUDE_PAGE, () => { if (stopped) throw new Error('Claude session stopped before applying source.'); }); await styles.init();
    scripts = new RendererScriptController({ cdp: page, appName: 'Claude', assertPage: async () => (await styles.frame()).id });
    scripts.on('console', event => {
      try { logs.append(event).catch(error => { recordError(error); stop('extension-log-error'); }); }
      catch (error) { recordError(error); stop('extension-log-error'); }
    });
    scripts.on('reapplied', states => { if (!stopped) pendingJS = { phase: 'active', jsStates: rendererStateProof(states), error: null }; });
    scripts.on('failure', error => {
      if (recoverableExtensionFailure(error)) pendingJS = { phase: 'error', jsStates: rendererStateProof(error.states), error: 'One or more Claude extensions failed to reload. See their logs.' };
      else { recordError('Imported JavaScript lifecycle failed; cleanup may be incomplete.'); stop('javascript-error'); }
    });
    await scripts.init();
    while (!stopped) {
      await requireOwner();
      const selection = await readClaudeExtensions(options.library);
      if (selection.revisionKey !== lastRevision || styles.needsUpdate) {
        pendingJS = null; await publish({ phase: 'applying', setupMessage: null });
        const applied = await applyCatalogSources(styles, scripts, selection, () => { lastRevision = undefined; });
        const css = applied, errorMessage = applied.error;
        const during = await inspectIntegrity(CLAUDE_BUNDLE); compareIntegrity(before, during); report.during = during;
        if (!stopped && !styles.needsUpdate && css.generation === styles.generation &&
            (await readClaudeExtensions(options.library)).revisionKey === selection.revisionKey) {
          const update = { phase: errorMessage ? 'error' : selection.hasContent ? 'active' : 'disabled',
            enabledExtensionIDs: selection.enabledExtensionIDs, cssBytes: selection.cssBytes, jsBytes: selection.jsBytes,
            jsStates: applied.jsStates, error: errorMessage ?? null, signatureUnchanged: true };
          appendCatalogRevision(report, { ...update, at: now(), stylesheetReadbackVerified: css.stylesheetReadbackVerified });
          lastRevision = selection.revisionKey; pendingJS = null;
          await publish({ ...update, revision: report.revisionCount });
        }
      }
      if (!stopped && pendingJS) {
        const update = pendingJS; pendingJS = null;
        const expected = new Map((status.jsStates ?? []).map(item => [item.extensionID, item.revision]));
        if (update.jsStates.length === expected.size && update.jsStates.every(item => expected.get(item.extensionID) === item.revision)) await publish(update);
      }
      if (!stopped) { await publish({}, true); await wait(750); }
    }
  } catch (error) {
    // A normal app quit can close the inspector before the next heartbeat.
    // Suppress a transport error only after positive kernel evidence that the
    // original process ended; an unreadable or foreign identity remains an error.
    if (identity && !originalEnded) { try { await requireProcess(); } catch {} }
    if (!originalEnded) recordError(error);
  }
  finally {
    try { await publish({ phase: 'stopping' }); } catch (error) { recordError(error); }
    if (scripts) {
      try { await scripts.dispose(); report.cleanup.jsCleanupVerified = true; }
      catch { report.cleanup.jsCleanupVerified = false; if (!originalEnded) recordError('Claude JavaScript cleanup could not be confirmed.'); }
    }
    if (styles) {
      try { await styles.dispose(); report.cleanup.stylesheetRemoved = true; }
      catch { report.cleanup.stylesheetRemoved = false; if (!originalEnded) recordError('Claude stylesheet cleanup could not be confirmed.'); }
    }
    try { await page?.close(); report.cleanup.rendererDebuggerDetached = Boolean(page); }
    catch { report.cleanup.rendererDebuggerDetached = false; if (!originalEnded) recordError('The owned renderer debugger could not be detached.'); }
    inspector?.close(); report.cleanup.controllerDisconnected = true; report.cleanup.targetTerminationRequested = false;
    if (before) {
      try { report.after = await inspectIntegrity(CLAUDE_BUNDLE); report.unchanged = compareIntegrity(before, report.after).unchanged; }
      catch (error) { recordError(error); }
    }
    if (identity) {
      report.cleanup.finalProcessObservation = await sampleCatalogSurvival(identity, { hasExited: () => originalEnded });
      report.cleanup.launchedAppLeftRunning = report.cleanup.finalProcessObservation.sameProcessAlive;
      report.cleanup.mainInspectorMayRemainOpen = report.cleanup.launchedAppLeftRunning !== false;
    }
    report.finishedAt = now(); report.stopReason = stopped ?? 'error';
    try { await publish(catalogTerminalStatus(report)); }
    finally { process.off('SIGTERM', signal); process.off('SIGINT', signal); }
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await runClaudeDock(parseClaudeOptions(process.argv.slice(2))); if (report.errors.length) process.exitCode = 1; }
  catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
}
