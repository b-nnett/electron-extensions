import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedFixtureBundle as fixtureBundle, root } from '../../lib/fixture-session.mjs';
import { PipeCDP } from '../../lib/pipe-cdp.mjs';
import { RendererScriptController } from '../../lib/renderer-script-controller.mjs';
import { ExtensionSessionLogFile } from '../../lib/extension-session-logs.mjs';
import { inspectIntegrity, compareIntegrity } from '../../lib/integrity.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../../lib/process-identity.mjs';
import { parseFixtureApplicationRegistry } from '../dock-fixture-session.mjs';
import { sampleCatalogSurvival } from '../dock-catalog-session.mjs';

// Fixed project-owned app and checked-in example. No vendor, source, debugger,
// profile or executable arguments are accepted by this transport proof.
if (process.argv.length > 2) throw new Error('This owned-fixture proof accepts no arguments.');
const sessionID = randomUUID(), extensionID = randomUUID(), badID = randomUUID();
const output = path.join(root, 'output/release-review/2026-09-13', `imported-pipe-${sessionID}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const executable = path.join(fixtureBundle, 'Contents/MacOS/Style Lab');
const fixtureIdentifier = 'dev.extensionsanywhere.stylelab';
const expectedURL = pathToFileURL(path.join(fixtureBundle, 'Contents/Resources/app.asar/index.html')).href;
const report = { passed: false, startedAt: new Date().toISOString(), sessionID, fixture: fixtureBundle,
  scope: 'Shared imported renderer controller through an owned Style Lab CDP pipe; no vendor/native product coverage claim.', checks: [], hashes: {} };
for (const name of ['lib/pipe-cdp.mjs', 'lib/renderer-script-controller.mjs', 'lib/fixture-extension-runtime.mjs']) {
  report.hashes[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
}
const text = await readFile(path.join(root, 'examples/stylelab-script-button/main.js'), 'utf8');
const css = '.ea-stylelab-script-button { background-color: rgb(22, 163, 74); color: white; }';
const selected = [{ extensionID, revision: createHash('sha256').update(text).digest('hex'), files: [{ fileName: 'main.js', text }] }];
const logger = new ExtensionSessionLogFile(path.join(output, 'extension-logs.json'), sessionID, { appKey: fixtureIdentifier });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, profile, pipe, page, attachedSession, identity, targetId, controller, sheet, logError;
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
function fixtureRegistry() {
  const script = "ObjC.import('AppKit');var apps=$.NSWorkspace.sharedWorkspace.runningApplications;var result=[];for(var i=0;i<apps.count;i++){var app=apps.objectAtIndex(i);if(ObjC.unwrap(app.bundleIdentifier)==='dev.extensionsanywhere.stylelab')result.push({pid:Number(app.processIdentifier),bundleIdentifier:ObjC.unwrap(app.bundleIdentifier),bundlePath:ObjC.unwrap(app.bundleURL.path)});}JSON.stringify(result);";
  return parseFixtureApplicationRegistry(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }));
}
async function owner() {
  assert.ok(child && child.exitCode === null && child.signalCode === null, 'Owned fixture is alive');
  assert.ok(sameProcessIdentity(identity, await getProcessIdentity(child.pid)), 'Exact owned process identity');
}
async function assertPage() {
  await owner();
  const { targetInfos } = await pipe.call('Target.getTargets');
  const matches = targetInfos.filter(target => target.type === 'page' && target.url === expectedURL);
  assert.equal(matches.length, 1); assert.equal(matches[0].targetId, targetId);
  const { frameTree } = await page.call('Page.getFrameTree');
  assert.equal(frameTree.frame.url, expectedURL);
  return frameTree.frame.id;
}
async function count() {
  await assertPage();
  const { root: document } = await page.call('DOM.getDocument', { depth: 0 });
  return (await page.call('DOM.querySelectorAll', { nodeId: document.nodeId, selector: '.ea-stylelab-script-button' })).nodeIds.length;
}
async function setCSS(value) {
  const frameId = await assertPage();
  if (!sheet && value) sheet = (await page.call('CSS.createStyleSheet', { frameId, force: true })).styleSheetId;
  if (sheet) {
    await page.call('CSS.setStyleSheetText', { styleSheetId: sheet, text: value });
    assert.equal((await page.call('CSS.getStyleSheetText', { styleSheetId: sheet })).text, value);
  }
}
async function waitFor(predicate, label, attempts = 200) {
  for (let n = 0; n < attempts; n++) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
try {
  assert.equal(fixtureBundle, '/Applications/Style Lab.app');
  assert.equal(await realpath(fixtureBundle), fixtureBundle); assert.equal(await realpath(executable), executable);
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(fixtureBundle, 'Contents/Info.plist')]));
  assert.equal(info.CFBundleIdentifier, fixtureIdentifier); assert.equal(info.CFBundleExecutable, 'Style Lab');
  report.preflight = fixtureRegistry();
  assert.equal(report.preflight.length, 0, 'Existing registered fixture must not be reused or stopped');
  report.before = await inspectIntegrity(fixtureBundle);
  profile = await mkdtemp(path.join(tmpdir(), 'ea-owned-pipe-proof-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, ['--remote-debugging-pipe', `--user-data-dir=${profile}`], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  child.stderr.resume(); child.on('error', error => { report.spawnError = error.message; });
  child.once('exit', (code, signal) => { report.processExit = { code, signal, at: new Date().toISOString() }; });
  assert.ok(child.pid); identity = await getProcessIdentity(child.pid);
  assert.equal(identity.executable, executable); assert.equal(identity.uid, process.getuid());
  report.processIdentity = identity;
  pipe = new PipeCDP(child.stdio[4], child.stdio[3], { allowOwnedFixtureReload: true });
  report.browser = await pipe.call('Browser.getVersion');
  await waitFor(async () => {
    await owner();
    const { targetInfos } = await pipe.call('Target.getTargets');
    const matches = targetInfos.filter(target => target.type === 'page' && target.url === expectedURL);
    assert.ok(matches.length <= 1); targetId = matches[0]?.targetId; return Boolean(targetId);
  }, 'owned fixture page');
  const registered = fixtureRegistry();
  assert.equal(registered.length, 1); assert.equal(registered[0].pid, child.pid);
  assert.equal(await realpath(registered[0].bundlePath), fixtureBundle);
  await owner();
  attachedSession = (await pipe.call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  page = new EventEmitter();
  for (const event of ['Page.frameNavigated', 'Page.loadEventFired', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown',
    'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared']) {
    pipe.on(event, (params, session) => { if (session === attachedSession) page.emit(event, params); });
  }
  pipe.on('disconnected', error => page.emit('disconnected', error));
  page.call = async (method, params) => { await owner(); return pipe.call(method, params, attachedSession); };
  for (const method of ['Page.enable', 'DOM.enable', 'CSS.enable']) await page.call(method);
  await assertPage();
  await assert.rejects(page.call('Runtime.enable'), /not allowed/);
  pipe.enableRendererJavaScript(attachedSession);
  controller = new RendererScriptController({ cdp: page, assertPage, appName: 'Style Lab' });
  controller.on('console', event => logger.append(event).catch(error => { logError = error; }));
  controller.on('failure', error => { report.runtimeFailure = error.message; });
  await controller.init();
  await controller.sync(selected); await controller.sync(selected); await setCSS(css);
  assert.equal(await count(), 1);
  assert.deepEqual(await controller.evaluate('({require:typeof require,process:typeof process})'), { require: 'undefined', process: 'undefined' });
  assert.equal(await controller.evaluate(`getComputedStyle(document.getElementById('ea-stylelab-script-button-${extensionID}')).backgroundColor`), 'rgb(22, 163, 74)');
  await controller.evaluate(`document.getElementById('ea-stylelab-script-button-${extensionID}').click()`);
  await waitFor(() => controller.logs().some(event => event.message === 'Style Lab script button clicked 1'), 'attributed click');
  check('Granted pipe session applies CSS and one imported button with attributed handler output and no Node globals');

  const invalid = { extensionID: badID, revision: 'syntax', files: [{ fileName: 'invalid.js', text: 'const = ;' }] };
  await assert.rejects(controller.sync([...selected, invalid]), error => {
    assert.equal(error.states.find(state => state.extensionID === extensionID).phase, 'active');
    const failed = error.states.find(state => state.extensionID === badID);
    assert.equal(failed.phase, 'failed'); assert.equal(failed.cleanupComplete, true); return true;
  });
  assert.equal(await count(), 1); await controller.sync(selected);
  check('Attributed syntax failure leaves the independent healthy pipe extension running');
  const handler = { extensionID: badID, revision: 'handler', files: [{ fileName: 'handler.js', text:
    `const button=document.getElementById('ea-stylelab-script-button-${extensionID}');
     const fail=()=>{throw new Error('Owned pipe handler error');};
     ea.onDispose(()=>button.removeEventListener('click',fail));button.addEventListener('click',fail);` }] };
  await controller.sync([...selected, handler]);
  await controller.evaluate(`document.getElementById('ea-stylelab-script-button-${extensionID}').click()`);
  await waitFor(() => controller.logs().some(event => event.extensionID === badID && event.fileName === 'handler.js' && event.message.includes('Owned pipe handler error')), 'attributed uncaught handler error');
  await controller.sync(selected);
  check('Pipe Runtime exception events preserve authored handler attribution');

  const firstContext = controller.uniqueContext;
  let reapplied = false; controller.once('reapplied', () => { reapplied = true; });
  // CUA could not bind this test app. Reload is explicitly granted only by
  // this fixed owned-fixture runner; the production catalog rejects it.
  report.reloadTrigger = 'Page.reload on the exact owned fixture through a default-off test-transport capability; production catalog wrapper forbids this method.';
  await assertPage(); await page.call('Page.reload');
  sheet = null;
  await waitFor(() => reapplied, 'automatic pipe reload reapplication');
  await controller.reapplication; await controller.queue;
  assert.notEqual(controller.uniqueContext, firstContext); assert.equal(await count(), 1);
  await setCSS(css);
  await controller.evaluate(`document.getElementById('ea-stylelab-script-button-${extensionID}').click()`);
  await waitFor(() => controller.logs().filter(event => event.message === 'Style Lab script button clicked 1').length === 2, 'fresh document handler');
  check('Reload replaces the unique execution context and automatically recreates one button with monotonic logs');
  report.during = await inspectIntegrity(fixtureBundle); compareIntegrity(report.before, report.during);
  await controller.sync([]); await setCSS(''); assert.equal(await count(), 0);
  await controller.sync(selected); assert.equal(await count(), 1);
  await controller.dispose(); assert.equal(await count(), 0); report.scriptCleanupVerified = true;
  check('Disable, re-enable and controller disposal remove registered pipe resources');
  await logger.flush(); if (logError) throw logError;
  await pipe.call('Target.detachFromTarget', { sessionId: attachedSession });
  await assert.rejects(pipe.call('Runtime.enable', {}, attachedSession), /not allowed/);
  check('Explicit pipe detach revokes the renderer capability');
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (controller && !controller.closed) {
    try { await controller.dispose(); } catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  }
  report.pipeClosure = { at: new Date().toISOString(), directTerminationSignalSent: false };
  pipe?.close();
  if (pipe && child && child.exitCode === null && child.signalCode === null) {
    // Isolate the effect of closing the debugger pipe. No quit command or
    // process signal is sent during this bounded observation interval.
    try { await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'pipe-close normal exit', 30); }
    catch { /* Any survivor is cleaned up by the exact-owned fallback below. */ }
  }
  report.pipeClosure.normalExitObservedBeforeAnySignal = Boolean(child && child.exitCode === 0 && child.signalCode === null);
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      await owner(); report.pipeClosure.directTerminationSignalSent = true; child.kill('SIGTERM');
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'graceful owned child exit');
      report.ownedChildExited = true;
    } catch (error) { report.stopError = error.message; report.passed = false; process.exitCode = 1; child.unref(); }
  } else report.ownedChildExited = Boolean(child);
  if (profile && report.ownedChildExited) { await rm(profile, { recursive: true, force: true }); report.temporaryProfileRemoved = true; }
  try {
    const after = await inspectIntegrity(fixtureBundle); report.integrity = compareIntegrity(report.before, after);
    if (identity) report.finalProcessObservation = await sampleCatalogSurvival(identity, { hasExited: () => Boolean(report.processExit) });
    await logger.flush();
  } catch (error) { report.finalError = error.message; report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidence: ${output}`);
  if (report.error) console.error(report.error);
}
