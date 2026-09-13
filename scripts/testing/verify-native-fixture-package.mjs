import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CDP } from '../../lib/cdp.mjs';
import { inspectIntegrity } from '../../lib/integrity.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../../lib/process-identity.mjs';

// Observation/action adapter for two explicit, fixed native XCTest proofs. It cannot
// launch an app, accept source/expression/target/port arguments, or alter CSS.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = path.join(root, 'output/release-review/2026-09-13');
const targets = Object.freeze({
  stylelab: { bundle: '/Applications/Style Lab.app', appKey: 'dev.extensionsanywhere.stylelab', executable: 'Style Lab',
    prefix: 'native-fixture-package-', environment: 'EA_RUN_NATIVE_FIXTURE_PACKAGE_E2E', selector: '#signal-button', property: 'background-color', propertyKey: 'signalBackground', buttonPrefix: 'ea-stylelab-script-button-' },
  vscode: { bundle: '/Applications/Visual Studio Code.app', appKey: 'com.microsoft.VSCode', executable: 'Code',
    prefix: 'native-vscode-package-', environment: 'EA_RUN_NATIVE_VSCODE_PACKAGE_E2E',
    selector: 'html', property: 'outline-offset', propertyKey: 'documentOutlineOffset', buttonPrefix: 'ea-vscode-proof-' }
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert.ok(['--proof-root', '--action', '--session', '--extension-id', '--app', '--diagnostic-output'].includes(key) && value && options[key] === undefined, 'Invalid proof argument.');
  options[key] = value;
}
const proof = options['--proof-root'];
const action = options['--action'];
const app = options['--app'] ?? 'stylelab';
assert.ok(Object.hasOwn(targets, app));
const target = targets[app], fixture = target.bundle, appKey = target.appKey;
assert.equal(process.env[target.environment], '1', 'Explicit native product proof opt-in required.');
assert.ok(typeof proof === 'string' && path.dirname(proof) === base &&
  path.basename(proof).startsWith(target.prefix) && uuid.test(path.basename(proof).slice(target.prefix.length)));
assert.equal(await realpath(proof), proof);
assert.ok(['integrity', 'observe', 'click', 'reload', 'request-reload', 'capture-button', 'capture-control'].includes(action));
if (action === 'reload') assert.equal(app, 'stylelab', 'Raw page reload is only permitted in owned Style Lab.');
if (action === 'request-reload') {
  assert.equal(app, 'vscode');
  assert.equal(process.env.EA_NATIVE_PROOF_MANUAL_RELOAD, '1', 'Native VS Code reload checkpoint opt-in required.');
}
if (action.startsWith('capture-')) {
  if (action === 'capture-control') assert.equal(app, 'stylelab', 'A vendor document root must never be captured.');
  assert.equal(process.env.EA_NATIVE_PROOF_DIAGNOSTICS, '1', 'Explicit cropped screenshot opt-in required.');
  assert.equal(path.dirname(options['--diagnostic-output'] || ''), proof);
  assert.match(path.basename(options['--diagnostic-output'] || ''), /^[a-z0-9-]+\.png$/);
} else assert.equal(options['--diagnostic-output'], undefined);

async function readJSON(file, maximum = 64 * 1024) {
  assert.equal(await realpath(file), file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    assert.ok(before.isFile() && before.size <= maximum);
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    assert.ok(bytesRead <= maximum && bytesRead === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs);
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

// The deterministic live path cannot be supplied by the caller or redirected
// by a receipt. Matching bounded receipts only establish run/path consistency.
const liveBase = path.join(os.homedir(), 'Library/Application Support/Extensions Anywhere Native E2E');
const live = path.join(liveBase, path.basename(proof));
assert.equal(await realpath(liveBase), liveBase);
assert.equal(await realpath(live), live);
const receipt = await readJSON(path.join(proof, 'live-artifacts-receipt.json'), 8192);
assert.deepEqual(receipt, await readJSON(path.join(live, 'test-run-receipt.json'), 8192));
assert.equal(receipt.schema, 1);
assert.equal(receipt.runID, path.basename(proof).slice(target.prefix.length));
assert.equal(receipt.appKey, appKey);
assert.equal(receipt.uid, process.getuid());
assert.equal(receipt.evidenceDirectory, proof);
assert.equal(receipt.liveDirectory, live);

if (action === 'integrity') {
  assert.equal(options['--session'], undefined);
  assert.equal(options['--extension-id'], undefined);
  process.stdout.write(JSON.stringify(await inspectIntegrity(fixture)) + '\n');
} else {
  const session = options['--session'], extensionID = options['--extension-id'];
  assert.ok(uuid.test(extensionID || ''));
  const relative = path.relative(live, session || '').split(path.sep);
  assert.ok(relative.length === 4 && relative[0] === 'Launchers' && /^[a-f0-9]{64}$/.test(relative[1]) && relative[2] === 'Sessions' && uuid.test(relative[3]));
  assert.equal(await realpath(session), session);
  const launcher = path.dirname(path.dirname(session));
  assert.equal((await readJSON(path.join(launcher, 'latest-session.json'))).path, session);
  const config = await readJSON(path.join(launcher, 'configuration.json'));
  assert.equal(config.profile, app);
  assert.equal(config.targetBundlePath, fixture);
  assert.equal(config.targetBundleIdentifier, appKey);
  assert.equal(config.libraryPath, path.join(live, 'library.json'));
  const status = await readJSON(path.join(session, 'status.json'));
  assert.equal(status.appKey, appKey);
  assert.equal(status.bundle, fixture);
  assert.ok(Number.isInteger(status.port) && status.port > 0 && status.port <= 65535);
  assert.ok(['active', 'disabled', 'applying'].includes(status.phase));
  const identity = await getProcessIdentity(status.pid);
  assert.equal(identity?.executable, path.join(fixture, 'Contents/MacOS', target.executable));
  assert.equal(identity?.uid, process.getuid());
  assert.ok(sameProcessIdentity(status.processIdentity, identity));
  const expectedPage = app === 'stylelab' ? pathToFileURL(path.join(fixture, 'Contents/Resources/app.asar/index.html')).href : null;
  function isExpectedPage(value) {
    if (expectedPage) return value === expectedPage;
    try {
      const url = new URL(value);
      return url.protocol === 'vscode-file:' && url.hostname === 'vscode-app' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
        decodeURIComponent(url.pathname) === `${fixture}/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html`;
    } catch { return false; }
  }
  const response = await fetch(`http://127.0.0.1:${status.port}/json/list`, { signal: AbortSignal.timeout(3000) });
  const pages = (await response.json()).filter(item => item.type === 'page' && isExpectedPage(item.url));
  assert.equal(pages.length, 1);
  if (app === 'vscode') assert.equal(pages[0].id, (await readJSON(path.join(session, 'report.json'), 1024 * 1024)).target?.id);
  const socket = new URL(pages[0].webSocketDebuggerUrl);
  assert.equal(socket.protocol, 'ws:');
  assert.equal(socket.hostname, '127.0.0.1');
  assert.equal(socket.port, String(status.port));
  const cdp = new CDP(socket.href);
  try {
    await cdp.ready;
    await cdp.call('DOM.enable');
    await cdp.call('CSS.enable');
    await cdp.call('Page.enable');
    const selector = `#${target.buttonPrefix}${extensionID}`;
    async function observe() {
      assert.ok(sameProcessIdentity(identity, await getProcessIdentity(status.pid)));
      const { frameTree } = await cdp.call('Page.getFrameTree');
      assert.ok(isExpectedPage(frameTree.frame.url));
      const { root: document } = await cdp.call('DOM.getDocument');
      const { nodeIds } = await cdp.call('DOM.querySelectorAll', { nodeId: document.nodeId, selector });
      let clickCount = null, background = null;
      if (nodeIds.length === 1) {
        const { attributes } = await cdp.call('DOM.getAttributes', { nodeId: nodeIds[0] });
        const countIndex = attributes.indexOf('data-click-count');
        clickCount = countIndex < 0 ? null : Number(attributes[countIndex + 1]);
        const { computedStyle } = await cdp.call('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] });
        background = computedStyle.find(item => item.name === 'background-color')?.value;
      }
      const { nodeId: signal } = await cdp.call('DOM.querySelector', { nodeId: document.nodeId, selector: target.selector });
      assert.ok(signal);
      const { computedStyle } = await cdp.call('CSS.getComputedStyleForNode', { nodeId: signal });
      return { count: nodeIds.length, clickCount, background,
        [target.propertyKey]: computedStyle.find(item => item.name === target.property)?.value,
        phase: status.phase, revision: status.revision, pageRouteVerified: true };
    }
    let reloadRequest;
    if (action === 'request-reload') {
      const current = await observe();
      assert.equal(current.count, 1);
      assert.equal(current.clickCount, 1);
      reloadRequest = { schema: 1, requested: true, appKey, targetPID: status.pid,
        sessionID: relative[3], extensionID, requestedAt: new Date().toISOString(),
        instruction: 'Use the native Developer: Reload Window command in this newly launched VS Code window.' };
      await writeFile(path.join(proof, 'reload-request.json'), JSON.stringify(reloadRequest) + '\n', { mode: 0o600, flag: 'wx' });
    } else if (action === 'click') {
      const { root: document } = await cdp.call('DOM.getDocument');
      const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: document.nodeId, selector });
      assert.ok(nodeId, 'Owned extension button must exist before the click.');
      const { model } = await cdp.call('DOM.getBoxModel', { nodeId });
      const points = model.content;
      const position = { x: (points[0] + points[2] + points[4] + points[6]) / 4,
        y: (points[1] + points[3] + points[5] + points[7]) / 4, button: 'left', clickCount: 1 };
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...position });
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position });
    } else if (action === 'reload') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cdp.off('Page.loadEventFired', loaded); reject(new Error('Owned page reload timed out.')); }, 10000);
        const loaded = () => { clearTimeout(timer); resolve(); };
        cdp.once('Page.loadEventFired', loaded);
        cdp.call('Page.reload').catch(error => { clearTimeout(timer); cdp.off('Page.loadEventFired', loaded); reject(error); });
      });
    } else if (action.startsWith('capture-')) {
      const { root: document } = await cdp.call('DOM.getDocument');
      const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: document.nodeId,
        selector: action === 'capture-button' ? selector : target.selector });
      assert.ok(nodeId);
      const { model } = await cdp.call('DOM.getBoxModel', { nodeId });
      const x = Math.min(model.border[0], model.border[2], model.border[4], model.border[6]);
      const y = Math.min(model.border[1], model.border[3], model.border[5], model.border[7]);
      const width = Math.max(model.border[0], model.border[2], model.border[4], model.border[6]) - x;
      const height = Math.max(model.border[1], model.border[3], model.border[5], model.border[7]) - y;
      assert.ok(width > 0 && height > 0 && width <= 400 && height <= 140, 'Diagnostic crop must contain only the proof control.');
      const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } });
      await writeFile(options['--diagnostic-output'], Buffer.from(data, 'base64'), { mode: 0o600, flag: 'wx' });
    }
    process.stdout.write(JSON.stringify(reloadRequest ?? await observe()) + '\n');
  } finally { cdp.close(); }
}
