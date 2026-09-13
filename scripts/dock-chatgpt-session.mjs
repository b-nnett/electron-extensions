import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, realpath, rename, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CDP } from '../lib/cdp.mjs';
import { ChatGPTStylesheet, isChatGPTAppPage } from '../lib/chatgpt-stylesheet.mjs';
import { CHATGPT_APP_KEY } from '../lib/dock-library.mjs';
import { readChatGPTExtensions, uniqueChatGPTTarget, chatGPTRendererPage, applyChatGPTSources, chatGPTTerminalStatus, confirmChatGPTApplication } from '../lib/chatgpt-extensions.mjs';
import { RendererScriptController } from '../lib/renderer-script-controller.mjs';
import { ExtensionSessionLogFile, rendererStateProof, recoverableExtensionFailure } from '../lib/extension-session-logs.mjs';
import { verifyLoopbackOwnership, appendCatalogRevision, sampleCatalogSurvival, classifyCatalogDisconnect } from './dock-catalog-session.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../lib/process-identity.mjs';
import { DIAGNOSTIC_SCREENSHOT_FLAG, diagnosticArguments, RuntimeDiagnostics, guardDiagnosticTransport } from '../lib/runtime-diagnostics.mjs';

const exec = promisify(execFile);
const bundle = '/Applications/ChatGPT.app';
const executable = `${bundle}/Contents/MacOS/ChatGPT`;
const launchArguments = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
const now = () => new Date().toISOString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = child => child && child.exitCode === null && child.signalCode === null;

async function requireStoppedApp() {
  // Query the public macOS GUI-app registry, like the native launch helper.
  // Unreadable executable paths in unrelated processes do not establish that
  // those processes exited. Kernel identity still gates every renderer write.
  const script = "ObjC.import('AppKit'); var apps=$.NSWorkspace.sharedWorkspace.runningApplications; var result=[]; for (var i=0; i<apps.count; i++) { var app=apps.objectAtIndex(i); if (ObjC.unwrap(app.bundleIdentifier)==='com.openai.codex') result.push({pid:Number(app.processIdentifier),bundlePath:ObjC.unwrap(app.bundleURL.path)}); } JSON.stringify(result);";
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 });
  const applications = JSON.parse(stdout);
  if (!Array.isArray(applications)) throw new Error('Cannot read the macOS ChatGPT application registry.');
  if (applications.length) throw new Error('ChatGPT is already running. Quit it normally, then reopen it using the Extensions Anywhere Dock shortcut.');
}

export function parseChatGPTOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length;) {
    const key = argv[i++];
    if (key === DIAGNOSTIC_SCREENSHOT_FLAG && !options.diagnosticScreenshots) {
      options.diagnosticScreenshots = true;
      continue;
    }
    const value = argv[i++];
    if (!['--library', '--output'].includes(key) || options[key.slice(2)] ||
        !value || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw new Error('Usage: dock-chatgpt-session.mjs --library <absolute library.json> --output <new session directory> [--diagnostic-screenshots]');
    }
    options[key.slice(2)] = path.normalize(value);
  }
  if (!options.library || !options.output) throw new Error('Both --library and --output are required.');
  return options;
}

async function targetList(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('ChatGPT debugger target listing failed.');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('ChatGPT debugger target metadata exceeded 1 MiB.');
      chunks.push(item.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function chatGPTOutputDirectory(requested) {
  let ancestor = requested;
  const remainder = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error;
      remainder.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
  const output = path.join(ancestor, ...remainder);
  if (output.split(path.sep).some(part => part.toLowerCase().endsWith('.app'))) {
    throw new Error('Session files must be outside application bundles.');
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await readdir(output)).some(name => !['launcher.log', '.ea-session-owner.json'].includes(name) &&
      !/^\.ea-session-owner-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}\.tmp$/.test(name))) {
    throw new Error('Use a new session directory; previous session files are preserved.');
  }
  return output;
}

async function atomicJSON(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

export async function captureChatGPTDiagnostic({ diagnostics, styles, cdp, phase, revision }) {
  return diagnostics.capture(`revision-${revision}-${phase}.png`, async () => {
    await styles.frame();
    const { cssVisualViewport: viewport } = await cdp.call('Page.getLayoutMetrics');
    if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight) ||
        viewport.clientWidth <= 0 || viewport.clientHeight <= 0 || viewport.clientWidth * viewport.clientHeight > 16 * 1024 * 1024) {
      throw new Error('The diagnostic renderer viewport exceeds screenshot limits.');
    }
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (typeof data !== 'string' || data.length > 12 * 1024 * 1024) throw new Error('Invalid diagnostic screenshot response.');
    return Buffer.from(data, 'base64');
  });
}

export async function runChatGPTDock(suppliedOptions) {
  const options = parseChatGPTOptions(['--library', suppliedOptions.library, '--output', suppliedOptions.output, ...diagnosticArguments(suppliedOptions)]);
  const output = await chatGPTOutputDirectory(options.output);
  const diagnostics = new RuntimeDiagnostics({ enabled: options.diagnosticScreenshots === true, output });
  const report = {
    appKey: CHATGPT_APP_KEY, bundle, startedAt: now(), brokerPid: process.pid,
    scope: 'Imported CSS and JavaScript in the packaged ChatGPT desktop page through ordinary renderer debugging. No Node access, CSP bypass or target-bundle changes.',
    launchArguments, revisions: [], revisionCount: 0, droppedRevisions: 0, errors: [], cleanup: {}
  };
  let status = { phase: 'starting', appKey: CHATGPT_APP_KEY, bundle, brokerPid: process.pid, pid: null, revision: 0,
    heartbeatVersion: 1, startedAt: report.startedAt, phaseStartedAt: report.startedAt };
  let lastHeartbeat = 0;
  let child, cdp, styles, scripts, identity, port, before, lastRevision, stopReason, launchError;
  let validateSelectedTarget, pendingScriptUpdate, pendingDisconnectError, targetEnded = false, jsReapplications = 0;
  const recordError = error => { if (report.errors.length < 16) report.errors.push(String(error?.message ?? error).slice(0, 4096)); };
  const directoryID = path.basename(output);
  const sessionID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(directoryID) ? directoryID : randomUUID();
  report.sessionID = sessionID; status.sessionID = sessionID; status.jsStates = [];
  const extensionLogs = new ExtensionSessionLogFile(path.join(output, 'extension-logs.json'), sessionID, { appKey: CHATGPT_APP_KEY });
  let stopResolve;
  const stopped = new Promise(resolve => { stopResolve = resolve; });
  const stop = reason => { if (!stopReason) { stopReason = reason; stopResolve(); } };
  const onSignal = () => stop('controller-stopped');
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);

  async function publish(update = {}) {
    report.diagnostics = diagnostics.summary;
    const publishedAt = now();
    if (update.phase && update.phase !== status.phase) status.phaseStartedAt = publishedAt;
    status = { ...status, ...update, updatedAt: publishedAt };
    status.heartbeatAt = status.updatedAt;
    await atomicJSON(path.join(output, 'report.json'), report);
    await atomicJSON(path.join(output, 'status.json'), status);
    lastHeartbeat = Date.now();
  }

  async function heartbeat() {
    if (Date.now() - lastHeartbeat < 2000) return;
    const heartbeatAt = now();
    status = { ...status, updatedAt: heartbeatAt, heartbeatAt };
    await atomicJSON(path.join(output, 'status.json'), status);
    lastHeartbeat = Date.now();
  }

  async function requireOwner() {
    if (targetEnded || !alive(child)) throw new Error('The ChatGPT process launched for this session has exited.');
    const current = await getProcessIdentity(child.pid);
    if (current === null || (current?.pid === identity?.pid && current.started !== identity.started)) {
      targetEnded = true; stop('app-exited');
      throw new Error('The original ChatGPT process exited or its PID identity changed.');
    }
    if (!sameProcessIdentity(identity, current)) throw new Error('ChatGPT process identity changed; the session stopped.');
    const { stdout } = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { timeout: 5000, maxBuffer: 65536 });
    if (!verifyLoopbackOwnership(stdout, child.pid, port)) {
      throw new Error('The launched ChatGPT process does not own the expected loopback debugger.');
    }
  }

  async function apply(selection) {
    if (stopReason) return;
    if (lastRevision === selection.revisionKey && !styles.needsUpdate) return;
    pendingScriptUpdate = null;
    await publish({ phase: 'applying' });
    const voiceExtension = selection.extensions.some(item => item.name === 'Hide Sidebar Voice Button' || item.name === 'Extensions Anywhere E2E — chatgpt');
    let originalVoice = await styles.voice();
    if (selection.hasCSS && voiceExtension) {
      const readyBy = Date.now() + 15000;
      while (originalVoice.matches !== 1 && !stopReason && Date.now() < readyBy) {
        await delay(150);
        if ((await readChatGPTExtensions(options.library)).revisionKey !== selection.revisionKey) return;
        originalVoice = await styles.voice();
      }
      if (!stopReason && originalVoice.matches !== 1) {
        throw new Error('The English sidebar Voice button did not become available in the selected ChatGPT window. No stylesheet was applied.');
      }
    }
    if (stopReason) return;
    if ((await readChatGPTExtensions(options.library)).revisionKey !== selection.revisionKey) return;
    const screenshots = {};
    screenshots.before = await captureDiagnostic('before');
    const applied = await applyChatGPTSources(styles, scripts, selection, () => { lastRevision = undefined; });
    const appliedVoice = applied.voice;
    const generation = applied.generation;
    if (selection.hasCSS && voiceExtension && (appliedVoice.matches !== 1 || appliedVoice.display !== 'none')) {
      throw new Error('The stylesheet loaded, but the sidebar Voice button was not verified hidden. Check the app version and English-language selector.');
    }
    screenshots.after = await captureDiagnostic('after');
    const after = await inspectIntegrity(bundle);
    compareIntegrity(before, after);
    if (!await confirmChatGPTApplication({ selection, styles, generation,
      readSelection: () => readChatGPTExtensions(options.library), stopped: () => Boolean(stopReason) })) return;
    appendCatalogRevision(report, {
      at: now(), phase: applied.phase, ...(applied.error ? { error: applied.error } : {}), enabledExtensionIDs: selection.enabledExtensionIDs,
      cssBytes: selection.cssBytes, cssSha256: selection.sha256, jsBytes: selection.jsBytes, jsStates: applied.jsStates,
      stylesheetReadbackVerified: true, originalVoice, appliedVoice,
      signatureUnchanged: true, screenshots, screenshotScope: diagnostics.summary.screenshotScope
    });
    lastRevision = selection.revisionKey; pendingScriptUpdate = null;
    await publish({
      phase: applied.phase, revision: report.revisionCount, error: applied.error ?? null,
      enabledExtensionIDs: selection.enabledExtensionIDs, cssBytes: selection.cssBytes, jsBytes: selection.jsBytes, jsStates: applied.jsStates,
      signatureUnchanged: true, voice: appliedVoice
    });
  }

  async function captureDiagnostic(phase) {
    return captureChatGPTDiagnostic({ diagnostics, styles, cdp, phase, revision: report.revisionCount + 1 });
  }

  try {
    await publish();
    const selection = await readChatGPTExtensions(options.library);
    if (!selection.hasContent) throw new Error('No enabled ChatGPT extension is available. Open ChatGPT normally.');
    const canonicalExecutable = await realpath(executable);
    if (canonicalExecutable !== executable) throw new Error('The installed ChatGPT executable is not at its expected path.');
    const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${bundle}/Contents/Info.plist`]);
    if (stdout.trim() !== CHATGPT_APP_KEY) throw new Error('The installed ChatGPT bundle identity does not match.');
    await requireStoppedApp();
    if (stopReason) return report;
    before = await inspectIntegrity(bundle);
    report.before = before;
    if (stopReason) return report;
    await requireStoppedApp();
    if (stopReason) return report;
    if (!(await readChatGPTExtensions(options.library)).hasContent) throw new Error('The enabled ChatGPT extension content changed before launch; no app was launched.');
    if (stopReason) return report;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, launchArguments, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.once('error', error => { launchError = error; stop('launch-error'); });
    child.once('exit', (code, signal) => { targetEnded = true; report.processExit = { code, signal, at: now() }; stop('app-exited'); });
    let stderr = '';
    child.stderr.on('data', bytes => {
      // Inspect only startup endpoint metadata. Do not save application logs.
      stderr = (stderr + bytes.toString()).slice(-8192);
      const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (!port && match && Number.isInteger(Number(match[1])) && Number(match[1]) > 0 && Number(match[1]) <= 65535) port = Number(match[1]);
    });
    const deadline = Date.now() + 25000;
    while (!port && !stopReason && Date.now() < deadline) await delay(100);
    stderr = '';
    if (launchError) throw launchError;
    if (!port || !alive(child)) throw new Error('This ChatGPT launch did not expose the standard renderer debugger. No styles were applied.');
    identity = await getProcessIdentity(child.pid);
    if (identity?.executable !== executable || identity.uid !== process.getuid()) throw new Error('The launched process does not match ChatGPT and the current user.');
    report.processIdentity = identity;
    await requireOwner();
    let target;
    while (!stopReason && Date.now() < deadline) {
      await requireOwner();
      target = uniqueChatGPTTarget(await targetList(port));
      if (target?.webSocketDebuggerUrl) break;
      await delay(150);
    }
    if (!target?.webSocketDebuggerUrl || typeof target.id !== 'string' || !target.id) throw new Error('The packaged ChatGPT desktop page was not available. No styles were applied.');
    const endpoint = new URL(target.webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== port || endpoint.username || endpoint.password) {
      throw new Error('The page debugger does not match the launched ChatGPT process.');
    }
    await requireOwner();
    cdp = guardDiagnosticTransport(new CDP(endpoint.href), diagnostics);
    await cdp.ready;
    cdp.once('disconnected', () => stop('debugger-disconnected'));
    validateSelectedTarget = async () => {
      await requireOwner();
      uniqueChatGPTTarget(await targetList(port), target.id);
    };
    const page = chatGPTRendererPage(cdp, requireOwner);
    styles = new ChatGPTStylesheet(page, validateSelectedTarget, () => {
      if (stopReason) throw new Error('The session stopped before the stylesheet could be applied.');
    });
    await styles.init();
    scripts = new RendererScriptController({ cdp: page, appName: 'ChatGPT', assertPage: async () => {
      await validateSelectedTarget(); return (await styles.frame()).id;
    } });
    scripts.on('console', event => {
      try { extensionLogs.append(event).catch(() => { recordError('Extension log persistence failed.'); stop('extension-log-error'); }); }
      catch { recordError('Invalid attributed extension log event.'); stop('extension-log-error'); }
    });
    scripts.on('reapplied', states => {
      if (!stopReason) pendingScriptUpdate = { jsStates: rendererStateProof(states), phase: 'active', error: null,
        jsReapplications: ++jsReapplications, jsReappliedAt: now() };
    });
    scripts.on('failure', error => {
      if (cdp.socket.readyState !== 1) { stop('debugger-disconnected'); return; }
      if (recoverableExtensionFailure(error)) pendingScriptUpdate = { jsStates: rendererStateProof(error.states), phase: 'error',
        error: 'One or more extensions failed to reload. See their runtime logs.', jsReapplications: ++jsReapplications, jsReappliedAt: now() };
      else { recordError('Imported JavaScript lifecycle failed; cleanup may be incomplete.'); stop('javascript-error'); }
    });
    await scripts.init();
    await extensionLogs.flush();
    await publish({ pid: child.pid, port, processIdentity: identity });
    if (!stopReason) await apply(await readChatGPTExtensions(options.library));
    while (!stopReason) {
      let timer;
      await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, 750); }), stopped]);
      clearTimeout(timer);
      if (!stopReason) {
        await validateSelectedTarget();
        await apply(await readChatGPTExtensions(options.library));
        if (!stopReason && pendingScriptUpdate) {
          const update = pendingScriptUpdate; pendingScriptUpdate = null;
          const expected = new Map((status.jsStates ?? []).map(state => [state.extensionID, state.revision]));
          if (update.jsStates.length === expected.size && update.jsStates.every(state => expected.get(state.extensionID) === state.revision)) {
            report.latestJSReapplication = update; await publish(update);
          }
        }
        await heartbeat();
      }
    }
    if (stopReason === 'debugger-disconnected' && alive(child)) {
      await delay(500);
      if (alive(child)) throw new Error('The ChatGPT debugger disconnected. Styles are no longer being monitored.');
    }
  } catch (error) {
    if (identity && cdp?.socket.readyState !== 1) pendingDisconnectError = error;
    else if (!(targetEnded && report.revisionCount > 0 && stopReason === 'app-exited')) recordError(error);
  }
  finally {
    try { await publish({ phase: 'stopping' }); } catch (error) { recordError(error); }
    if (identity && cdp && cdp.socket.readyState !== 1) {
      const outcome = await classifyCatalogDisconnect(identity);
      report.cleanup.disconnectIdentity = outcome;
      if (outcome.originalProcessEnded || !alive(child)) {
        targetEnded = true;
        if (stopReason === 'debugger-disconnected') stopReason = 'app-exited';
      }
    }
    if (pendingDisconnectError && !(targetEnded && report.revisionCount > 0)) recordError(pendingDisconnectError);
    // Remove extension handlers before CSS, then detach the owned TCP connection.
    // Never request target termination when this broker stops.
    if (scripts && !targetEnded && alive(child) && cdp?.socket.readyState === 1) {
      try { await scripts.dispose(); report.cleanup.jsCleanupVerified = true; }
      catch { recordError('Imported JavaScript cleanup could not be verified.'); report.cleanup.jsCleanupVerified = false; }
    } else if (scripts) {
      report.cleanup.jsEndedWithApp = targetEnded || !alive(child); report.cleanup.jsCleanupVerified = false;
      if (!targetEnded && alive(child)) recordError('ChatGPT may still be running; JavaScript removal could not be confirmed after disconnection.');
    }
    try { await extensionLogs.flush(); } catch { recordError('Extension log persistence failed.'); }
    if (styles && !targetEnded && alive(child) && cdp?.socket.readyState === 1) {
      try { await styles.dispose(); report.cleanup.stylesheetRemoved = true; }
      catch (error) { recordError(`Stylesheet cleanup: ${error.message}`); report.cleanup.stylesheetRemoved = false; }
    } else if (styles) {
      report.cleanup.stylesheetEndedWithApp = targetEnded || !alive(child);
      if (!targetEnded && alive(child)) {
        report.cleanup.stylesheetRemovalUnresolved = true;
        recordError('ChatGPT is still running, but the debugger disconnected before stylesheet removal could be confirmed.');
      }
    }
    cdp?.close();
    report.cleanup.controllerDisconnected = true;
    if (child) { child.stderr?.destroy(); child.unref(); }
    report.cleanup.targetTerminationRequested = false;

    report.cleanup.noAppLaunched = !child;

    if (before) {
      try { report.after = await inspectIntegrity(bundle); report.unchanged = compareIntegrity(before, report.after).unchanged; }
      catch (error) { recordError(`Integrity check: ${error.message}`); }
    }
    if (identity) {
      const survival = await sampleCatalogSurvival(identity, { hasExited: () => targetEnded || !alive(child) });
      report.cleanup.finalProcessObservation = survival;
      report.cleanup.launchedAppLeftRunning = survival.sameProcessAlive;
      if (survival.sameProcessAlive === null) recordError('Final process ownership could not be confirmed; app survival is unknown.');
    } else report.cleanup.launchedAppLeftRunning = child ? null : false;
    report.cleanup.debuggerMayRemainOpen = Boolean(port && report.cleanup.launchedAppLeftRunning !== false);
    report.finishedAt = now();
    report.stopReason = stopReason ?? 'error';
    try { await publish(chatGPTTerminalStatus(report)); }
    finally { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); }
  }
  if (report.errors.length) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseChatGPTOptions(process.argv.slice(2));
    if (options.diagnosticScreenshots) process.stderr.write('Screenshot diagnostics enabled: complete visible app content may be saved in the selected session directory (up to 64 captures / 64 MiB).\n');
    await runChatGPTDock(options);
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
