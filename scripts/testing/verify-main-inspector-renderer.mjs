import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedFixtureBundle as fixtureBundle, root } from '../../lib/fixture-session.mjs';
import { CDP } from '../../lib/cdp.mjs';
import { MainInspectorRenderer } from '../../lib/main-inspector-renderer.mjs';
import { InspectorRendererStylesheet } from '../../lib/claude-extensions.mjs';
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
const output = path.join(root, 'output/release-review/2026-09-13', `main-inspector-renderer-${sessionID}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const executable = path.join(fixtureBundle, 'Contents/MacOS/Style Lab');
const fixtureIdentifier = 'dev.extensionsanywhere.stylelab';
const expectedURL = pathToFileURL(path.join(fixtureBundle, 'Contents/Resources/app.asar/index.html')).href;
const report = { passed: false, startedAt: new Date().toISOString(), sessionID, fixture: fixtureBundle,
  scope: 'Shared imported renderer controller through the fixed owned Style Lab main-inspector bridge; no vendor/native product coverage claim.', checks: [], hashes: {} };
for (const name of ['lib/main-inspector-renderer.mjs', 'lib/claude-extensions.mjs', 'lib/renderer-script-controller.mjs', 'lib/fixture-extension-runtime.mjs']) {
  report.hashes[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
}
const text = await readFile(path.join(root, 'examples/stylelab-script-button/main.js'), 'utf8');
const css = '.ea-stylelab-script-button { background-color: rgb(22, 163, 74); color: white; }';
const selected = [{ extensionID, revision: createHash('sha256').update(text).digest('hex'), files: [{ fileName: 'main.js', text }] }];
const logger = new ExtensionSessionLogFile(path.join(output, 'extension-logs.json'), sessionID, { appKey: fixtureIdentifier });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, profile, inspector, page, identity, controller, styles, logError, inspectorURL;
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
function fixtureRegistry() {
  const script = "ObjC.import('AppKit');var apps=$.NSWorkspace.sharedWorkspace.runningApplications;var result=[];for(var i=0;i<apps.count;i++){var app=apps.objectAtIndex(i);if(ObjC.unwrap(app.bundleIdentifier)==='dev.extensionsanywhere.stylelab')result.push({pid:Number(app.processIdentifier),bundleIdentifier:ObjC.unwrap(app.bundleIdentifier),bundlePath:ObjC.unwrap(app.bundleURL.path)});}JSON.stringify(result);";
  return parseFixtureApplicationRegistry(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }));
}
async function owner() {
  assert.ok(child && child.exitCode === null && child.signalCode === null, 'Owned fixture is alive');
  assert.ok(sameProcessIdentity(identity, await getProcessIdentity(child.pid)), 'Exact owned process identity');
  if (inspectorURL) {
    const port = new URL(inspectorURL).port;
    const output = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.deepEqual([...output.matchAll(/^p(\d+)$/gm)].map(x => Number(x[1])), [child.pid]);
    assert.deepEqual([...output.matchAll(/^n(.+)$/gm)].map(x => x[1]), [`127.0.0.1:${port}`]);
  }
}
async function assertPage() { await owner(); return (await styles.frame()).id; }
async function count() { return controller.evaluate('document.querySelectorAll(".ea-stylelab-script-button").length'); }
async function setCSS(value) { return styles.set(value); }
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
  profile = await mkdtemp(path.join(tmpdir(), 'ea-owned-main-inspector-proof-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, ['--inspect=127.0.0.1:0', `--user-data-dir=${profile}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65536); inspectorURL ??= stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+)/)?.[1]; }); child.on('error', error => { report.spawnError = error.message; });
  child.once('exit', (code, signal) => { report.processExit = { code, signal, at: new Date().toISOString() }; });
  assert.ok(child.pid); identity = await getProcessIdentity(child.pid);
  assert.equal(identity.executable, executable); assert.equal(identity.uid, process.getuid());
  report.processIdentity = identity;
  await waitFor(() => Boolean(inspectorURL), 'owned main inspector');
  await owner();
  inspector = new CDP(inspectorURL, 15000); await inspector.ready;
  page = new MainInspectorRenderer({ inspector, requireOwner: owner, ownedFixture: true });
  page.on('failure', error => { report.bridgeFailure = error.message; });
  await page.prepare(); let target;
  await waitFor(async () => { target = await page.discover(); return target.ready; }, 'owned fixture document');
  assert.equal(target.debuggerAttached, false); await page.attach(target.id);
  const registered = fixtureRegistry(); assert.equal(registered.length, 1); assert.equal(registered[0].pid, child.pid);
  styles = new InspectorRendererStylesheet(page, url => url === expectedURL); await styles.init();
  await assert.rejects(page.call('Browser.close'), /outside/);
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
  check('Granted main-inspector bridge applies CSS and one imported button with attributed handler output and no Node globals');

  const invalid = { extensionID: badID, revision: 'syntax', files: [{ fileName: 'invalid.js', text: 'const = ;' }] };
  await assert.rejects(controller.sync([...selected, invalid]), error => {
    assert.equal(error.states.find(state => state.extensionID === extensionID).phase, 'active');
    const failed = error.states.find(state => state.extensionID === badID);
    assert.equal(failed.phase, 'failed'); assert.equal(failed.cleanupComplete, true); return true;
  });
  assert.equal(await count(), 1); await controller.sync(selected);
  check('Attributed syntax failure leaves the independent healthy bridge extension running');
  const handler = { extensionID: badID, revision: 'handler', files: [{ fileName: 'handler.js', text:
    `const button=document.getElementById('ea-stylelab-script-button-${extensionID}');
     const fail=()=>{throw new Error('Owned bridge handler error');};
     ea.onDispose(()=>button.removeEventListener('click',fail));button.addEventListener('click',fail);` }] };
  await controller.sync([...selected, handler]);
  await controller.evaluate(`document.getElementById('ea-stylelab-script-button-${extensionID}').click()`);
  await waitFor(() => controller.logs().some(event => event.extensionID === badID && event.fileName === 'handler.js' && event.message.includes('Owned bridge handler error')), 'attributed uncaught handler error');
  await controller.sync(selected);
  check('Bridge Runtime exception events preserve authored handler attribution');

  const firstContext = controller.uniqueContext;
  let reapplied = false; controller.once('reapplied', () => { reapplied = true; });
  // Only the fixed owned-fixture adapter permits this test reload. No vendor is selected.
  report.reloadTrigger = 'Page.reload through the fixed owned-fixture main adapter only; the production Claude adapter refuses this method.';
  await assertPage(); await page.call('Page.reload');
  await waitFor(() => reapplied, 'automatic bridge reload reapplication');
  await controller.reapplication; await controller.queue;
  assert.notEqual(controller.uniqueContext, firstContext); assert.equal(await count(), 1);
  await setCSS(css);
  await controller.evaluate(`document.getElementById('ea-stylelab-script-button-${extensionID}').click()`);
  await waitFor(() => controller.logs().filter(event => event.message === 'Style Lab script button clicked 1').length === 2, 'fresh document handler');
  check('Reload replaces the unique execution context and automatically recreates one button with monotonic logs');
  report.during = await inspectIntegrity(fixtureBundle); compareIntegrity(report.before, report.during);
  await controller.sync([]); await setCSS(''); assert.equal(await count(), 0);
  await controller.sync(selected); assert.equal(await count(), 1);
  const cleanupContext = controller.uniqueContext;
  await controller.dispose();
  const cleanupReadback = await page.call('Runtime.evaluate', { expression: 'document.querySelectorAll(".ea-stylelab-script-button").length', uniqueContextId: cleanupContext, returnByValue: true, awaitPromise: true, timeout: 10000, allowUnsafeEvalBlockedByCSP: false });
  assert.equal(cleanupReadback.result.value, 0); report.scriptCleanupVerified = true;
  check('Disable, re-enable and controller disposal remove registered bridge resources');
  await logger.flush(); if (logError) throw logError;
  await styles.dispose(); styles = null; report.stylesheetCleanupVerified = true;
  await page.close(); await assert.rejects(page.call('Page.getFrameTree'), /closed/);
  inspector.close(); await delay(500); await owner();
  report.bridgeClosedAppStillRunning = true;
  check('Bridge shutdown detaches only its renderer debugger and leaves the exact target process running');
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (controller && !controller.closed) {
    try { await controller.dispose(); } catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  }
  try { await styles?.dispose(); await page?.close(); } catch (error) { report.bridgeCleanupError = error.message; report.passed = false; process.exitCode = 1; }
  inspector?.close();
  report.directTerminationSignalSent = false;
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      await owner(); report.directTerminationSignalSent = true; child.kill('SIGTERM');
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
