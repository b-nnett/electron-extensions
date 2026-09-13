import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, realpath, rename, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { CDP } from '../lib/cdp.mjs';
import { PipeCDP } from '../lib/pipe-cdp.mjs';
import { CatalogStylesheet, readBoundedJSON, readCatalogExtensions, validateCatalogProfile, uniqueCatalogTarget,
  isCatalogAppPage, supportsCatalogJavaScript, isCatalogJavaScriptPage } from '../lib/catalog-stylesheet.mjs';
import { RendererScriptController } from '../lib/renderer-script-controller.mjs';
import { ExtensionSessionLogFile, rendererStateProof, recoverableExtensionFailure } from '../lib/extension-session-logs.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../lib/process-identity.mjs';
import { OwnedCatalogLocalService } from '../lib/owned-local-service.mjs';
import { DIAGNOSTIC_SCREENSHOT_FLAG, diagnosticArguments, RuntimeDiagnostics } from '../lib/runtime-diagnostics.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'compatibility/runtime-profiles.json');
const now = () => new Date().toISOString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_REVISIONS = 64;
const PAGE_METHODS = new Set(['Page.enable', 'Page.getFrameTree', 'Page.captureScreenshot', 'Page.getLayoutMetrics',
  'DOM.enable', 'DOM.getDocument', 'DOM.querySelectorAll', 'DOM.getBoxModel', 'CSS.enable',
  'CSS.getComputedStyleForNode', 'CSS.createStyleSheet', 'CSS.setStyleSheetText', 'CSS.getStyleSheetText']);
const SCRIPT_METHODS = new Set(['Runtime.enable', 'Runtime.evaluate', 'Runtime.compileScript', 'Page.createIsolatedWorld']);

export function catalogRendererPage({ transport, profile, requireOwner, diagnostics, call, sessionID = null }) {
  const page = new EventEmitter(), permitsScripts = supportsCatalogJavaScript(profile);
  for (const event of ['Page.frameNavigated', ...(permitsScripts ? ['Page.loadEventFired', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown',
    'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared'] : [])]) {
    transport.on(event, (params, incomingSession) => { if (sessionID === null || incomingSession === sessionID) page.emit(event, params); });
  }
  if (permitsScripts) transport.on('disconnected', () => page.emit('disconnected'));
  page.call = async (method, params = {}) => {
    if (!PAGE_METHODS.has(method) && !(permitsScripts && SCRIPT_METHODS.has(method))) throw new Error('This profile does not permit that renderer operation.');
    if (method === 'Runtime.evaluate' && params.allowUnsafeEvalBlockedByCSP !== false) throw new Error('Renderer evaluation cannot bypass CSP.');
    if (method === 'Page.createIsolatedWorld' && (params.grantUniveralAccess || params.grantUniversalAccess)) throw new Error('Renderer worlds cannot receive universal access.');
    diagnostics.requireAllowedMethod(method);
    await requireOwner();
    return call(method, params);
  };
  return page;
}

export async function applyCatalogSources(styles, scripts, selection, invalidateAppliedRevision = () => {}) {
  // An old confirmed revision ceases to describe the renderer as soon as any
  // mutation begins, even if later verification sees a changed library.
  invalidateAppliedRevision();
  const css = await styles.set(selection.hasCSS ? selection.css : '');
  try {
    return { ...css, phase: selection.hasContent ? 'active' : 'disabled', jsStates: rendererStateProof(await scripts.sync(selection.jsExtensions)) };
  } catch (error) {
    if (!recoverableExtensionFailure(error)) throw error;
    return { ...css, phase: 'error', jsStates: rendererStateProof(error.states),
      error: 'One or more extensions failed to load. See their runtime logs.' };
  }
}

// TargetInfo can advertise a pending navigation before the committed root
// document exists. Wait only for classified uncommitted startup roots, never
// for off-origin pages or during ordinary application.
export async function waitForCatalogInitialFrame(styles, { validateTarget, stopped, deadline,
  clock = Date.now, pause = delay, observe = () => {} }) {
  let attempts = 0, lastFrameRoute = null;
  while (!stopped()) {
    await validateTarget();
    try {
      await styles.frame();
      const receipt = { state: 'ready', attempts: ++attempts, waitedForCommit: attempts > 1,
        ...(lastFrameRoute ? { previousFrame: lastFrameRoute } : {}) };
      observe(receipt); return receipt;
    } catch (error) {
      attempts++; lastFrameRoute = error.frameRoute ?? null;
      observe({ state: 'rejected', attempts, ...(lastFrameRoute ? { frame: lastFrameRoute } : {}) });
      if (error.code !== 'CATALOG_INITIAL_FRAME_PENDING') throw error;
      if (clock() >= deadline) throw new Error('The selected renderer did not commit an allowed app document before the startup deadline.');
      observe({ state: 'waiting-for-commit', attempts, frame: lastFrameRoute });
      await pause(150);
    }
  }
  const receipt = { state: 'stopped', attempts }; observe(receipt); return receipt;
}

export async function publishCatalogDebuggerEndpoint({ port, requireOwner, publish, report }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The renderer debugger port is invalid.');
  await requireOwner();
  report.debugger = { transport: 'tcp', host: '127.0.0.1', port, ownershipVerifiedAt: now() };
  await publish({ port });
}

export function catalogTerminalStatus(report) {
  return { phase: report.errors.length ? 'error' : 'stopped', pid: null, port: null,
    enabledExtensionIDs: [], cssBytes: 0, jsBytes: 0, jsStates: [], error: report.errors.join(' ') || null };
}

export function appendCatalogRevision(report, entry) {
  const number = (report.revisionCount ?? 0) + 1;
  if (!Number.isSafeInteger(number)) throw new Error('The session revision counter is exhausted.');
  const recorded = { ...entry, number };
  report.revisionCount = number;
  report.revisions.push(recorded);
  if (report.revisions.length > MAX_REVISIONS) {
    const removed = report.revisions.length - MAX_REVISIONS;
    report.revisions.splice(0, removed);
    report.droppedRevisions = (report.droppedRevisions ?? 0) + removed;
  }
  return recorded;
}

// Sample after transport closure and final integrity work. Pipe closure can
// itself request normal Quit in Electron; an earlier alive sample is stale.
export async function sampleCatalogSurvival(identity, {
  readIdentity = getProcessIdentity, hasExited = () => false, clock = now
} = {}) {
  let current, error;
  try { current = await readIdentity(identity.pid); }
  catch (failure) { error = String(failure.message).slice(0, 1000); }
  const observedAt = clock();
  if (hasExited()) return { observedAt, sameProcessAlive: false, reason: 'observed-original-process-exit' };
  if (error) return { observedAt, sameProcessAlive: null, reason: 'identity-unresolved', error };
  if (current === null) return { observedAt, sameProcessAlive: false, reason: 'kernel-confirmed-absence' };
  if (current?.pid === identity.pid && /^[1-9]\d*\.\d{6}$/.test(current.started ?? '') && current.started !== identity.started) {
    return { observedAt, sameProcessAlive: false, reason: 'kernel-confirmed-pid-reuse' };
  }
  return { observedAt, sameProcessAlive: sameProcessIdentity(identity, current) ? true : null,
    reason: sameProcessIdentity(identity, current) ? 'same-process-observed-running' : 'identity-unresolved' };
}

export function catalogNativeHelperPath(runtimeRoot = root) {
  if (!path.isAbsolute(runtimeRoot) || path.normalize(runtimeRoot) !== runtimeRoot) throw new Error('Invalid catalog runtime root.');
  if (runtimeRoot.endsWith('/Contents/Resources/Runtime')) return path.join(runtimeRoot, 'native/CatalogAppLaunch');
  // A packaged helper must never reach back into a developer checkout when a
  // bundled dependency is absent. This fallback is solely the raw CLI layout.
  if (runtimeRoot.split(path.sep).some(part => part.toLowerCase().endsWith('.app'))) throw new Error('The app has no supported packaged catalog runtime layout.');
  return path.join(runtimeRoot, 'dist/Extensions Anywhere.app/Contents/Resources/CatalogAppLaunch');
}

export function parseCatalogOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length;) {
    const key = argv[i++];
    if (key === DIAGNOSTIC_SCREENSHOT_FLAG && !options.diagnosticScreenshots) {
      options.diagnosticScreenshots = true;
      continue;
    }
    const value = argv[i++];
    if (!['--app', '--library', '--output'].includes(key) || options[key.slice(2)] ||
        typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('Usage: dock-catalog-session.mjs --app <catalog slug> --library <absolute JSON> --output <new absolute directory> [--diagnostic-screenshots]');
    options[key.slice(2)] = value;
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.app ?? '') || !path.isAbsolute(options.library ?? '') || !path.isAbsolute(options.output ?? '')) throw new Error('A fixed catalog slug and absolute library/output paths are required.');
  return { ...options, library: path.normalize(options.library), output: path.normalize(options.output) };
}

async function outputDirectory(requested) {
  let ancestor = requested; const tail = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error;
      tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
  const output = path.join(ancestor, ...tail);
  if (output.split(path.sep).some(part => part.toLowerCase().endsWith('.app'))) throw new Error('Session evidence must be outside application bundles.');
  await mkdir(output, { recursive: true, mode: 0o700 });
  // A new native wrapper writes only its log and ownership marker before the
  // broker starts. Existing reports/images still make the directory unusable.
  if ((await readdir(output)).some(name => !['launcher.log', '.ea-session-owner.json'].includes(name) &&
      !/^\.ea-session-owner-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}\.tmp$/.test(name))) {
    throw new Error('Use a new session directory; existing evidence is preserved.');
  }
  return output;
}

async function atomicJSON(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

async function registeredApps(profile) {
  const script = `ObjC.import('AppKit'); var apps=$.NSWorkspace.sharedWorkspace.runningApplications; var result=[]; for(var i=0;i<apps.count;i++){var a=apps.objectAtIndex(i);var id=ObjC.unwrap(a.bundleIdentifier), p=ObjC.unwrap(a.bundleURL.path);if(id===${JSON.stringify(profile.bundleIdentifier)}||p===${JSON.stringify(profile.bundlePath)})result.push({pid:Number(a.processIdentifier),bundlePath:p,bundleIdentifier:id});} JSON.stringify(result);`;
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000, maxBuffer: 65536 });
  const apps = JSON.parse(stdout);
  if (!Array.isArray(apps) || apps.some(app => !Number.isInteger(app.pid) || app.pid <= 0 || typeof app.bundlePath !== 'string')) throw new Error('Invalid macOS app registry response.');
  return apps;
}

async function requireStoppedApp(profile) {
  if ((await registeredApps(profile)).length) throw new Error(`${profile.name} is already running. Quit it normally before launching its extension shortcut.`);
}

export function verifyLoopbackOwnership(stdout, pid, port) {
  let owner = null; const listeners = [];
  for (const line of stdout.split('\n')) {
    if (/^p\d+$/.test(line)) owner = Number(line.slice(1));
    else if (line.startsWith('n')) listeners.push({ owner, address: line.slice(1) });
  }
  return listeners.length > 0 && listeners.every(item => item.owner === pid && item.address === `127.0.0.1:${port}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function targetList(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Debugger target listing failed.');
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Debugger target metadata exceeded 1 MiB.');
      chunks.push(item.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); }
}

// A disconnected renderer is not evidence of process exit. During normal Quit,
// its pipe/socket can close shortly before the exact app process disappears.
export async function classifyCatalogDisconnect(identity, {
  readIdentity = getProcessIdentity, wait = delay, clock = Date.now, graceMs = 1500
} = {}) {
  const started = clock(), budget = Math.min(Math.max(graceMs, 0), 1500);
  let attempts = 0, last;
  if (!sameProcessIdentity(identity, identity)) return { originalProcessEnded: false, sameProcessAlive: null, reason: 'invalid-original-identity', attempts: 0, waitedMs: 0 };
  while (attempts < 16) {
    attempts++;
    try {
      const current = await readIdentity(identity.pid);
      if (current === null) return { originalProcessEnded: true, sameProcessAlive: false, reason: 'kernel-confirmed-absence', attempts, waitedMs: clock() - started };
      if (current?.pid === identity.pid && /^[1-9]\d*\.\d{6}$/.test(current.started ?? '') && current.started !== identity.started) {
        return { originalProcessEnded: true, sameProcessAlive: false, reason: 'kernel-confirmed-pid-reuse', attempts, waitedMs: clock() - started };
      }
      last = sameProcessIdentity(identity, current)
        ? { originalProcessEnded: false, sameProcessAlive: true, reason: 'same-process-still-running' }
        : { originalProcessEnded: false, sameProcessAlive: null, reason: 'identity-unresolved' };
    } catch (error) {
      last = { originalProcessEnded: false, sameProcessAlive: null, reason: 'identity-unresolved', error: String(error.message).slice(0, 1000) };
    }
    const remaining = budget - (clock() - started);
    if (remaining <= 0 || attempts >= 16) break;
    await wait(Math.min(100, remaining));
  }
  return { ...last, attempts, waitedMs: clock() - started };
}

export function catalogLaunchSummary({ requested, identityVerified, failedBeforeStart = false }) {
  return { launchRequested: requested, launchOutcomeUnknown: requested && !identityVerified && !failedBeforeStart,
    noAppLaunched: !requested || failedBeforeStart };
}

/** Observe the optional diagnostic control without changing app behavior. */
export async function observePaintedCatalogControl(styles, { visible = false, diagnostics = new RuntimeDiagnostics() } = {}) {
  // Explicit diagnostics may prime a paused renderer's paint with a discarded
  // bounded capture. Normal operation reads CSS metadata without any capture.
  await diagnostics.capture(null, () => styles.screenshot());
  let control = await styles.settledControl();
  if (visible) {
    const visibleControl = await styles.control({ visible: true });
    if (JSON.stringify(visibleControl.computed) !== JSON.stringify(control.computed)) {
      throw new Error('The original control changed after its bounded settled observation.');
    }
    control = { ...visibleControl, observation: control.observation };
  }
  return { ...control, observation: { ...control.observation, viewportCapturePrimed: diagnostics.enabled } };
}

// This loop is used only before the next stylesheet write. A startup render
// can replace a queried node before its computed-style/box read completes.
// Each retry discards that node ID and rechecks the selected target and owner.
export async function waitForOriginalCatalogControl(styles, {
  validateTarget, stopped = () => false, wait = delay, clock = Date.now, diagnostics = new RuntimeDiagnostics()
}) {
  const deadline = clock() + 15000;
  for (let attempt = 0; !stopped(); attempt++) {
    await validateTarget(); // Ambiguity or ownership errors are never retried.
    if (stopped()) return;
    try {
      await styles.control({ visible: true });
      return await observePaintedCatalogControl(styles, { visible: true, diagnostics });
    } catch (error) {
      const staleNode = /^(?:DOM\.querySelectorAll|DOM\.getBoxModel|CSS\.getComputedStyleForNode): Could not find node with given id$/.test(error.message ?? '');
      if ((error.code !== 'CONTROL_NOT_READY' && !staleNode) || clock() >= deadline || attempt >= 100) throw error;
      if (stopped()) return;
      await wait(Math.min(150, deadline - clock()));
    }
  }
}

export async function runCatalogDock(suppliedOptions) {
  const options = parseCatalogOptions(['--app', suppliedOptions.app, '--library', suppliedOptions.library, '--output', suppliedOptions.output, ...diagnosticArguments(suppliedOptions)]);
  const output = await outputDirectory(options.output);
  const diagnostics = new RuntimeDiagnostics({ enabled: options.diagnosticScreenshots === true, output });
  const report = { slug: options.app, startedAt: now(), brokerPid: process.pid,
    scope: 'Curated app identity and ordinary renderer debugging; stored CSS and explicitly configured renderer JavaScript, normal user profile, no target bundle changes, Node access or CSP bypass.',
    revisions: [], revisionCount: 0, droppedRevisions: 0, errors: [], cleanup: {}, launchRequested: false, launchOutcomeUnknown: false };
  let status = { phase: 'starting', slug: options.app, brokerPid: process.pid, pid: null, port: null,
    heartbeatVersion: 1, startedAt: report.startedAt, phaseStartedAt: report.startedAt, revision: 0 };
  let profile, child, targetPid, identity, port, before, pipe, cdp, page, styles, sessionId, localService, scripts, extensionLogs;
  let pendingScriptUpdate = null, jsReapplications = 0;
  const logSessionID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(path.basename(output)) ? path.basename(output) : randomUUID();
  let route = {}, validateSelectedTarget;
  let targetEnded = false, connected = false, lastRevision, activeRevision, baseline, stopReason, launchError, lastHeartbeat = 0;
  let pendingDisconnectError, launchFailedBeforeStart = false;
  let stopResolve; const stopped = new Promise(resolve => { stopResolve = resolve; });
  const stop = reason => { if (!stopReason) { stopReason = reason; stopResolve(); } };
  const onSignal = () => stop('controller-stopped');
  const errorText = error => String(error?.message ?? error).slice(0, 2000);
  const recordError = error => { if (report.errors.length < 16) report.errors.push(errorText(error)); };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);

  async function publish(update = {}, statusOnly = false) {
    try { await extensionLogs?.flush(); }
    catch { recordError('Extension log persistence failed.'); stop('extension-log-error'); update = { ...update, phase: 'error', error: 'Extension log persistence failed.' }; }
    report.diagnostics = diagnostics.summary;
    const timestamp = now();
    if (update.phase && update.phase !== status.phase) status.phaseStartedAt = timestamp;
    status = { ...status, ...update, updatedAt: timestamp, heartbeatAt: timestamp };
    if (!statusOnly) await atomicJSON(path.join(output, 'report.json'), report);
    await atomicJSON(path.join(output, 'status.json'), status); lastHeartbeat = Date.now();
  }
  async function transportCall(operation) {
    try { return await operation(); }
    catch (error) { if (!connected) error.catalogTransportDisconnected = true; throw error; }
  }
  async function requireOwner({ listener = true } = {}) {
    if (!identity || targetEnded) throw new Error('The app process owned by this session has exited.');
    let current;
    try { current = await getProcessIdentity(targetPid); }
    catch (error) { if (!connected && (pipe || cdp)) error.catalogTransportDisconnected = true; throw error; }
    if (!current || current.started !== identity.started) {
      targetEnded = true; stop('app-exited');
      throw new Error('The original app process exited or its PID identity changed.');
    }
    if (!sameProcessIdentity(identity, current)) throw new Error('The app process ownership changed; no renderer commands are permitted.');
    if (localService) await localService.check(current);
    if (listener && port) {
      const { stdout } = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { timeout: 5000, maxBuffer: 65536 });
      if (!verifyLoopbackOwnership(stdout, targetPid, port)) throw new Error('The debugger port is not exclusively owned by the selected app on 127.0.0.1.');
    }
  }
  async function capture(label, clip, revision = report.revisionCount + 1) {
    const file = `revision-${revision}-${label}.png`;
    return diagnostics.capture(file, () => styles.screenshot(clip));
  }
  async function removeCSS(reason) {
    if (!styles?.sheet) { baseline = null; activeRevision = null; return; }
    await styles.set(''); lastRevision = undefined; report.cleanup.stylesheetRemoved = true;
    if (!scripts && baseline && baseline.generation === styles.generation) {
      const restored = await observePaintedCatalogControl(styles, { diagnostics });
      const matches = JSON.stringify(restored.computed) === JSON.stringify(baseline.computed);
      const screenshot = await capture('restored', baseline.clip, activeRevision?.number);
      if (activeRevision) activeRevision.restoration = { at: now(), reason, computed: restored.computed, computedObservation: restored.observation, baselineMatches: matches, screenshot, stylesheetReadbackVerified: true };
      if (!matches) throw new Error('The stylesheet was removed, but the known control did not return to its recorded computed baseline.');
    }
    baseline = null; activeRevision = null;
  }
  async function applyMixed(selection) {
    if (stopReason || (lastRevision === selection.revisionKey && !styles.needsUpdate)) return;
    pendingScriptUpdate = null;
    await publish({ phase: 'applying' });
    await validateSelectedTarget();
    if ((await readCatalogExtensions(options.library, profile)).revisionKey !== selection.revisionKey) return;
    // Runtime health is established by the owned document, stylesheet readback
    // and script state. A vendor's diagnostic control may disappear on reload.
    const result = await applyCatalogSources(styles, scripts, selection, () => { lastRevision = undefined; });
    const during = await inspectIntegrity(profile.bundlePath); compareIntegrity(before, during); report.during = during;
    if (stopReason || styles.needsUpdate || result.generation !== styles.generation) return;
    if ((await readCatalogExtensions(options.library, profile)).revisionKey !== selection.revisionKey) return;
    const entry = { at: now(), phase: result.phase,
      enabledExtensionIDs: selection.enabledExtensionIDs, cssBytes: selection.cssBytes, cssSha256: selection.sha256,
      jsBytes: selection.jsBytes, jsStates: result.jsStates, stylesheetReadbackVerified: result.stylesheetReadbackVerified,
      jsExtensions: selection.jsExtensions.map(({ extensionID, revision, files }) => ({ extensionID, revision,
        files: files.map(({ fileName, text }) => ({ fileName, bytes: Buffer.byteLength(text) })) })),
      signatureUnchanged: true, screenshotScope: 'not-collected',
      diagnosticControl: { collected: false, reason: 'Mixed runtime does not inspect a vendor proof control.' },
      ...(result.error ? { error: result.error } : {}) };
    activeRevision = appendCatalogRevision(report, entry); baseline = null;
    lastRevision = selection.revisionKey; pendingScriptUpdate = null;
    report.cleanup.stylesheetRemoved = !selection.hasCSS;
    await publish({ phase: result.phase, revision: report.revisionCount, enabledExtensionIDs: selection.enabledExtensionIDs,
      cssBytes: selection.cssBytes, jsBytes: selection.jsBytes, jsStates: result.jsStates, signatureUnchanged: true,
      error: result.error ?? null });
  }
  async function apply(selection) {
    if (scripts) return applyMixed(selection);
    if (stopReason || (lastRevision === selection.revisionKey && !styles.needsUpdate)) return;
    await publish({ phase: 'applying' });
    if (baseline?.generation !== styles.generation) { baseline = null; activeRevision = null; }
    await removeCSS(selection.hasCSS ? 'replaced' : 'disabled');
    if (stopReason) return;
    if ((await readCatalogExtensions(options.library, profile)).revisionKey !== selection.revisionKey) return;
    if (!selection.hasCSS) {
      appendCatalogRevision(report, { at: now(), enabledExtensionIDs: [], cssBytes: 0, stylesheetReadbackVerified: true });
      const during = await inspectIntegrity(profile.bundlePath); compareIntegrity(before, during);
      report.during = during; lastRevision = selection.revisionKey;
      if (!stopReason) await publish({ phase: 'disabled', revision: report.revisionCount, enabledExtensionIDs: [], cssBytes: 0, signatureUnchanged: true });
      return;
    }
    const control = await waitForOriginalCatalogControl(styles, { validateTarget: validateSelectedTarget, stopped: () => Boolean(stopReason), diagnostics });
    if (stopReason) return;
    if ((await readCatalogExtensions(options.library, profile)).revisionKey !== selection.revisionKey) return;
    baseline = { ...control, generation: styles.generation };
    const original = await capture('before', control.clip);
    const result = await styles.set(selection.css);
    const applied = await observePaintedCatalogControl(styles, { diagnostics });
    const styled = await capture('styled', control.clip);
    const during = await inspectIntegrity(profile.bundlePath); compareIntegrity(before, during); report.during = during;
    if (stopReason || styles.needsUpdate || result.generation !== styles.generation) return;
    if ((await readCatalogExtensions(options.library, profile)).revisionKey !== selection.revisionKey) return;
    activeRevision = appendCatalogRevision(report, { at: now(), enabledExtensionIDs: selection.enabledExtensionIDs, cssBytes: selection.cssBytes,
      cssSha256: selection.sha256, stylesheetReadbackVerified: true, originalComputed: control.computed, originalComputedObservation: control.observation, appliedComputed: applied.computed, computedObservation: applied.observation,
      screenshots: { before: original, styled }, signatureUnchanged: true,
      screenshotScope: diagnostics.summary.screenshotScope,
      visualReview: diagnostics.enabled ? 'Explicit diagnostic PNGs captured; visual inspection is separate.' : 'No screenshot collection during normal runtime.' });
    lastRevision = selection.revisionKey;
    report.cleanup.stylesheetRemoved = false;
    await publish({ phase: 'active', revision: report.revisionCount, enabledExtensionIDs: selection.enabledExtensionIDs,
      cssBytes: selection.cssBytes, signatureUnchanged: true, computed: applied.computed });
  }

  try {
    await publish();
    const catalog = await readBoundedJSON(manifest, 1024 * 1024);
    if (!Array.isArray(catalog) || catalog.length > 64 || new Set(catalog.map(item => item?.slug)).size !== catalog.length) throw new Error('Invalid fixed runtime profile catalog.');
    const matches = catalog.filter(item => item?.slug === options.app);
    if (matches.length !== 1) throw new Error('This app has no curated ordinary runtime profile.');
    profile = validateCatalogProfile(matches[0]);
    report.appKey = profile.bundleIdentifier; report.bundle = profile.bundlePath; report.profile = profile;
    status.appKey = report.appKey; status.bundle = report.bundle;
    if (supportsCatalogJavaScript(profile)) {
      report.scope = `Curated ${profile.name} renderer CSS and imported JavaScript in an isolated world; normal user profile, no Node access or CSP bypass, unchanged vendor bundle.${profile.slug === 'figma' ? ' Figma login page only; workspace and editor coverage is not verified.' : ''}`;
      report.sessionID = logSessionID; status.sessionID = logSessionID; status.jsStates = [];
      extensionLogs = new ExtensionSessionLogFile(path.join(output, 'extension-logs.json'), logSessionID, { appKey: profile.bundleIdentifier });
    }
    await publish();
    if (!(await readCatalogExtensions(options.library, profile)).hasContent) throw new Error(`No enabled ${profile.name} extension content is available. Open the app normally.`);
    if (await realpath(profile.bundlePath) !== profile.bundlePath || await realpath(profile.executable) !== profile.executable) throw new Error('The catalog app or executable moved or resolves through a different path.');
    const info = JSON.parse((await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(profile.bundlePath, 'Contents/Info.plist')], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout);
    if (info.CFBundleIdentifier !== profile.bundleIdentifier || path.join(profile.bundlePath, 'Contents/MacOS', info.CFBundleExecutable ?? '') !== profile.executable) throw new Error('The installed app does not match the catalog bundle/executable identity.');
    report.version = info.CFBundleShortVersionString; report.build = info.CFBundleVersion;
    await requireStoppedApp(profile); if (stopReason) return report;
    before = await inspectIntegrity(profile.bundlePath); report.before = before;
    if (stopReason) return report;
    await requireStoppedApp(profile);
    if (stopReason) return report;
    if (!(await readCatalogExtensions(options.library, profile)).hasContent) throw new Error('The enabled extension content changed before launch; no app was launched.');
    const launchedAt = Date.now(); report.launchedAt = new Date(launchedAt).toISOString();
    const deadline = launchedAt + 30000;
    if (profile.transport === 'launchservices-tcp') {
      port = await reservePort();
      if (stopReason) return report;
      const helper = catalogNativeHelperPath();
      if (await realpath(helper) !== helper) throw new Error('The signed catalog LaunchServices helper is unavailable at its fixed path. Rebuild Extensions Anywhere.');
      report.launchArguments = profile.arguments.map(argument => argument === '--remote-debugging-port=0' ? `--remote-debugging-port=${port}` : argument);
      report.launchRequested = true; report.launchOutcomeUnknown = true;
      await publish();
      if (stopReason) { report.launchRequested = false; report.launchOutcomeUnknown = false; return report; }
      const { stdout } = await exec(helper, ['--app', profile.slug, '--port', String(port)], { timeout: 30000, maxBuffer: 65536 });
      const launched = JSON.parse(stdout);
      if (!Number.isInteger(launched.pid) || launched.pid <= 0 || launched.executable !== profile.executable) throw new Error('The LaunchServices helper did not return the expected target PID/executable.');
      targetPid = launched.pid;
    } else {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const usePipe = profile.transport === 'pipe';
      report.launchRequested = true; report.launchOutcomeUnknown = true;
      await publish();
      if (stopReason) { report.launchRequested = false; report.launchOutcomeUnknown = false; return report; }
      child = spawn(profile.executable, profile.arguments, { env, detached: true, stdio: usePipe ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'] });
      report.launchArguments = profile.arguments;
      child.once('error', error => { launchError = error; launchFailedBeforeStart = !child.pid; stop('launch-error'); });
      child.once('exit', (code, signal) => { targetEnded = true; report.processExit = { at: now(), code, signal }; stop('app-exited'); });
      let endpointText = '';
      child.stderr.on('data', bytes => {
        // Only recognize standard loopback endpoint metadata; never persist app logs.
        if (usePipe || port) return;
        endpointText = (endpointText + bytes.toString()).slice(-8192);
        const match = endpointText.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) { port = Number(match[1]); endpointText = ''; }
      });
      if (!child.pid) { await delay(0); throw launchError ?? new Error('The app could not be started.'); }
      targetPid = child.pid;
      if (usePipe) { pipe = new PipeCDP(child.stdio[4], child.stdio[3]); connected = true; pipe.on('disconnected', () => { connected = false; stop('debugger-disconnected'); }); }
    }
    identity = await getProcessIdentity(targetPid);
    if (!identity || identity.executable !== profile.executable || identity.uid !== process.getuid() || Number(identity.started) * 1000 < launchedAt - 1000) throw new Error('The launched target has an unexpected kernel process identity.');
    report.processIdentity = identity;
    report.launchOutcomeUnknown = false;
    await publish({ pid: targetPid, processIdentity: identity });
    if (profile.transport !== 'pipe') {
      while (!port && !stopReason && Date.now() < deadline) await delay(100);
      if (!port || targetEnded) throw new Error('The ordinary launch did not expose a loopback renderer debugger.');
    }
    if (port) {
      while (!stopReason) {
        try { await publishCatalogDebuggerEndpoint({ port, requireOwner, publish, report }); break; }
        catch (error) {
          // A LaunchServices callback can arrive before the listener. Retry only
          // lsof's no-listener result, preserving every identity/mismatch failure.
          if (error.code !== 1 || error.stdout?.trim() || Date.now() >= deadline) throw error;
          await requireOwner({ listener: false }); await delay(100);
        }
      }
    } else { await requireOwner(); report.debugger = { transport: 'pipe' }; }
    if (profile.transport === 'launchservices-tcp') {
      const apps = await registeredApps(profile);
      if (apps.length !== 1 || apps[0].pid !== targetPid || apps[0].bundlePath !== profile.bundlePath) throw new Error('The LaunchServices callback does not match the sole running catalog app.');
    }
    let target;
    const discoveryRoute = { allowUnboundLocalService: true };
    while (!stopReason && Date.now() < deadline) {
      await requireOwner();
      const targets = pipe ? (await transportCall(() => pipe.call('Target.getTargets'))).targetInfos : await targetList(port);
      if (Array.isArray(targets)) report.targetDiscovery = { at: now(), count: targets.length,
        surfaces: targets.slice(0, 64).map(item => ({ type: String(item?.type ?? 'unknown').slice(0, 40), allowedRoute: isCatalogAppPage(item?.url, profile, discoveryRoute) })) };
      target = uniqueCatalogTarget(targets, profile, discoveryRoute);
      if (target) break;
      await delay(150);
    }
    if (stopReason) return report;
    if (!target) throw new Error('No unique renderer matched the fixed app URL route.');
    const targetId = pipe ? target.targetId : target.id;
    if (typeof targetId !== 'string' || !targetId || targetId.length > 256) throw new Error('The selected renderer has no valid target identifier.');
    if (profile.ownedLocalService) {
      const service = new OwnedCatalogLocalService(profile, identity);
      report.ownedLocalService = await service.bind(target.url);
      localService = service; route = { ownedServiceOrigin: service.origin };
      await publish();
    }
    report.target = { id: targetId, type: target.type, selector: profile.target.selector,
      urlSha256: createHash('sha256').update(target.url).digest('hex') };
    if (pipe) {
      await requireOwner();
      sessionId = (await transportCall(() => pipe.call('Target.attachToTarget', { targetId, flatten: true }))).sessionId;
      page = catalogRendererPage({ transport: pipe, profile, requireOwner, diagnostics, sessionID: sessionId,
        call: (method, params) => transportCall(() => pipe.call(method, params, sessionId)) });
    } else {
      const endpoint = new URL(target.webSocketDebuggerUrl);
      if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== port || endpoint.username || endpoint.password) throw new Error('The page endpoint does not belong to the verified loopback debugger.');
      await requireOwner(); cdp = new CDP(endpoint.href); await cdp.ready; connected = true;
      cdp.once('disconnected', () => { connected = false; stop('debugger-disconnected'); });
      page = catalogRendererPage({ transport: cdp, profile, requireOwner, diagnostics,
        call: (method, params) => transportCall(() => cdp.call(method, params)) });
    }
    styles = new CatalogStylesheet(page, profile, requireOwner, () => { if (stopReason) throw new Error('The controller stopped before applying CSS.'); }, route);
    validateSelectedTarget = async () => {
      await requireOwner();
      // Revalidate selected target metadata, not an old ID or the first page.
      const targets = await transportCall(async () => pipe ? (await pipe.call('Target.getTargets')).targetInfos : await targetList(port));
      // Include every syntactically eligible root in the ambiguity check, even
      // when a second root uses a different port. Only the pinned origin may win.
      const selected = uniqueCatalogTarget(targets, profile, discoveryRoute);
      if (!selected || (pipe ? selected.targetId : selected.id) !== targetId || !isCatalogAppPage(selected.url, profile, route)) throw new Error('The selected app renderer disappeared, changed route or became ambiguous.');
      if (supportsCatalogJavaScript(profile) && !isCatalogJavaScriptPage(selected.url, profile, route)) throw new Error(`JavaScript is restricted to the reviewed ${profile.name} renderer document.`);
    };
    await styles.init({ waitForFrame: () => waitForCatalogInitialFrame(styles, {
      validateTarget: validateSelectedTarget, stopped: () => Boolean(stopReason), deadline,
      pause: async ms => { await publish({}, true); await delay(ms); },
      observe: value => { report.initialFrameReadiness = value; }
    }) });
    if (stopReason) return report;
    if (supportsCatalogJavaScript(profile)) {
      await validateSelectedTarget();
      if (pipe) pipe.enableRendererJavaScript(sessionId);
      scripts = new RendererScriptController({ cdp: page, appName: profile.name, assertPage: async () => {
        await validateSelectedTarget();
        const frame = await styles.frame();
        if (!isCatalogJavaScriptPage(frame.url, profile, route)) throw new Error(`The current renderer is outside the reviewed ${profile.name} document.`);
        return frame.id;
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
        if (!connected) { stop('debugger-disconnected'); return; }
        if (recoverableExtensionFailure(error)) pendingScriptUpdate = { jsStates: rendererStateProof(error.states), phase: 'error',
          error: 'One or more extensions failed to reload. See their runtime logs.', jsReapplications: ++jsReapplications, jsReappliedAt: now() };
        else { recordError('Imported JavaScript lifecycle failed; cleanup may be incomplete.'); stop('javascript-error'); }
      });
      await scripts.init();
    }
    while (!stopReason) {
      await validateSelectedTarget();
      await apply(await readCatalogExtensions(options.library, profile));
      if (!stopReason && pendingScriptUpdate) {
        const update = pendingScriptUpdate; pendingScriptUpdate = null;
        const expected = new Map((status.jsStates ?? []).map(state => [state.extensionID, state.revision]));
        if (update.jsStates.length === expected.size && update.jsStates.every(state => expected.get(state.extensionID) === state.revision)) {
          report.latestJSReapplication = update;
          await publish(update);
        }
      }
      if (!stopReason && Date.now() - lastHeartbeat >= 2000) await publish({}, true);
      let timer; await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, 750); }), stopped]); clearTimeout(timer);
    }
  } catch (error) {
    if (error.catalogTransportDisconnected && identity) pendingDisconnectError = error;
    else if (!(targetEnded && ['app-exited', 'debugger-disconnected'].includes(stopReason) && report.revisions.length > 0)) recordError(error);
  } finally {
    try { await publish({ phase: 'stopping' }); } catch (error) { recordError(error); }
    if (identity && !connected && (pipe || cdp)) {
      const outcome = await classifyCatalogDisconnect(identity);
      report.cleanup.disconnectIdentity = outcome;
      if (outcome.originalProcessEnded || targetEnded) {
        targetEnded = true;
        if (stopReason === 'debugger-disconnected') stopReason = 'app-exited';
      }
    }
    if (pendingDisconnectError && !(targetEnded && report.revisions.length > 0)) recordError(pendingDisconnectError);
    if (scripts && !targetEnded && connected) {
      try { await scripts.dispose(); report.cleanup.jsCleanupVerified = true; }
      catch { recordError('Imported JavaScript cleanup could not be verified.'); report.cleanup.jsCleanupVerified = false; }
    } else if (scripts && targetEnded) {
      report.cleanup.jsEndedWithApp = true; report.cleanup.jsCleanupVerified = false;
    } else if (scripts) {
      report.cleanup.jsCleanupVerified = false;
      recordError('The app may still be running; JavaScript removal could not be confirmed after disconnection.');
    }
    if (styles && !targetEnded && connected) {
      try { await removeCSS('controller-stopped'); await styles.dispose(); report.cleanup.stylesheetRemoved = true; }
      catch (error) { recordError(`Stylesheet cleanup: ${errorText(error)}`); report.cleanup.stylesheetRemovalUnresolved = true; }
    } else if (styles && targetEnded) report.cleanup.stylesheetEndedWithApp = true;
    else if (styles) { report.cleanup.stylesheetRemovalUnresolved = true; recordError('The app may still be running, but the stylesheet removal could not be confirmed after transport disconnection.'); }
    if (pipe && sessionId && connected) {
      try { await pipe.call('Target.detachFromTarget', { sessionId }); report.cleanup.pageDetached = true; }
      catch (error) { recordError(`Page detach: ${errorText(error)}`); }
    }
    pipe?.close(); cdp?.close();
    if (child) { child.stderr?.destroy(); child.unref(); }
    report.cleanup.controllerDisconnected = true;
    report.cleanup.targetTerminationRequested = false;
    report.cleanup.pipeCloseMayQuitApp = Boolean(pipe);
    report.cleanup.transportClosedAt = now();
    const launchSummary = catalogLaunchSummary({ requested: report.launchRequested,
      identityVerified: Boolean(report.processIdentity), failedBeforeStart: launchFailedBeforeStart });
    report.launchOutcomeUnknown = launchSummary.launchOutcomeUnknown;
    report.cleanup.noAppLaunched = launchSummary.noAppLaunched;
    report.cleanup.launchOutcomeUnknown = launchSummary.launchOutcomeUnknown;
    if (launchSummary.launchOutcomeUnknown) report.cleanup.appMayRemainRunning = true;
    if (before) {
      try { report.after = await inspectIntegrity(profile.bundlePath); report.unchanged = compareIntegrity(before, report.after).unchanged; }
      catch (error) { recordError(`Integrity check: ${errorText(error)}`); }
    }
    if (identity) {
      const survival = await sampleCatalogSurvival(identity, { hasExited: () => targetEnded });
      report.cleanup.finalProcessObservation = survival;
      report.cleanup.launchedAppLeftRunning = survival.sameProcessAlive;
      if (survival.sameProcessAlive === false) targetEnded = true;
      if (survival.sameProcessAlive === null) recordError('Final process ownership could not be confirmed; app survival is unknown.');
    } else report.cleanup.launchedAppLeftRunning = targetEnded ? false : null;
    report.cleanup.debuggerMayRemainOpen = Boolean(port && targetPid && !targetEnded);
    report.finishedAt = now(); report.stopReason = stopReason ?? 'error';
    try { await publish(catalogTerminalStatus(report)); }
    finally { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCatalogOptions(process.argv.slice(2));
    if (options.diagnosticScreenshots) process.stderr.write('Screenshot diagnostics enabled: complete visible app content may be saved in the selected session directory (up to 64 captures / 64 MiB).\n');
    const report = await runCatalogDock(options);
    if (report.errors.length) { process.stderr.write(report.errors.join('\n') + '\n'); process.exitCode = 1; }
  } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
}
