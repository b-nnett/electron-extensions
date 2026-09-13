import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FixtureSession, fixtureBundle, root } from '../../lib/fixture-session.mjs';

// Fixed, project-owned fixture and checked-in example only. This is a lifecycle
// acceptance test, not a production extension loader or arbitrary target tool.
if (process.argv.length > 2) throw new Error('This proof accepts no target, source, or debugger arguments.');
const example = path.join(root, 'examples/stylelab-script-button');
const proofID = randomUUID();
const output = path.join(root, 'output/release-review/2026-09-13', `fixture-javascript-${proofID}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const hash = value => createHash('sha256').update(value).digest('hex');
const manifestText = await readFile(path.join(example, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
assert.deepEqual(manifest.css, ['styles.css']);
assert.deepEqual(manifest.js, ['main.js']);
assert.equal(manifest.manifest_version, 1);
const [css, script, coreSource] = await Promise.all([
  readFile(path.join(example, 'styles.css'), 'utf8'),
  readFile(path.join(example, 'main.js'), 'utf8'),
  readFile(path.join(root, 'lib/fixture-extension-runtime.mjs'), 'utf8')
]);
assert.ok(!/^import\s/m.test(coreSource), 'Owned renderer core must have no Node/module dependencies.');
const rendererCore = coreSource.replace(/^export /gm, '');
const extensionID = randomUUID();
const revision = hash(css + script);
const buttonID = `ea-stylelab-script-button-${extensionID}`;
const selector = `#${buttonID}`;
const report = {
  status: 'running', startedAt: new Date().toISOString(), fixture: fixtureBundle,
  scope: 'Checked-in mixed package in a separately launched owned Style Lab renderer. No GUI import, Dock broker, or third-party JavaScript support claim.',
  hashes: { manifest: hash(manifestText), css: hash(css), script: hash(script), core: hash(coreSource) },
  extensionID, revision, checks: []
};
const session = new FixtureSession({ enableButtonDemo: false });
let context;
const check = (name, details = {}) => {
  report.checks.push({ name, passed: true, ...details });
  console.log(`PASS ${name}`);
};
async function evaluate(expression) {
  const { frameTree } = await session.cdp.call('Page.getFrameTree');
  assert.equal(frameTree.frame.url, pathToFileURL(path.join(fixtureBundle, 'Contents/Resources/app.asar/index.html')).href);
  const response = await session.cdp.call('Runtime.evaluate', {
    expression, contextId: context, returnByValue: true, awaitPromise: true,
    timeout: 4000, allowUnsafeEvalBlockedByCSP: false
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function initializeDocument() {
  const { frameTree } = await session.cdp.call('Page.getFrameTree');
  const result = await session.cdp.call('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: 'extensions-anywhere-owned-package-proof'
  });
  context = result.executionContextId;
  await evaluate(`(() => { ${rendererCore}\n globalThis.__eaOwnedProof = new FixtureExtensionRuntime(); })()`);
  assert.deepEqual(await evaluate('({require: typeof require, process: typeof process})'), { require: 'undefined', process: 'undefined' });
}
async function enable(selectedRevision = revision) {
  return evaluate(`__eaOwnedProof.enable({extensionID:${JSON.stringify(extensionID)}, revision:${JSON.stringify(selectedRevision)},
    files:[{fileName:'main.js', execute:async function(ea, console) {\n${script}\n}}]})`);
}
async function count() { return evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`); }
async function click() {
  // User-like pointer event delivery confined to the owned fixture's new button.
  const { root: document } = await session.cdp.call('DOM.getDocument');
  const { nodeId } = await session.cdp.call('DOM.querySelector', { nodeId: document.nodeId, selector });
  assert.ok(nodeId);
  const { model } = await session.cdp.call('DOM.getBoxModel', { nodeId });
  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  const position = { x: (x1+x2+x3+x4)/4, y: (y1+y2+y3+y4)/4, button: 'left', clickCount: 1 };
  await session.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...position });
  await session.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position });
}
async function logs() { return evaluate('__eaOwnedProof.logs()'); }
async function screenshot(name) {
  const { data } = await session.cdp.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, name), Buffer.from(data, 'base64'), { mode: 0o600 });
}
async function disable() { return evaluate(`__eaOwnedProof.disable(${JSON.stringify(extensionID)})`); }

try {
  const launched = await session.start();
  report.before = launched.signature;
  report.fixturePID = launched.pid;
  await session.cdp.call('Runtime.enable');
  await initializeDocument();
  await screenshot('01-before.png');
  check('Exact owned fixture has no renderer Node access');

  await session.styles.apply(css);
  assert.equal((await enable()).phase, 'active');
  assert.equal(await count(), 1);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById(${JSON.stringify(buttonID)})).backgroundColor`), 'rgb(22, 163, 74)');
  await screenshot('02-css-and-javascript.png');
  check('Manifest CSS and JS add a styled button');

  await click();
  let events = (await logs()).filter(event => event.message.includes('Style Lab script button clicked'));
  assert.equal(events.length, 1);
  assert.equal(events[0].extensionID, extensionID);
  assert.equal(events[0].fileName, 'main.js');
  assert.equal(events[0].revision, revision);
  assert.equal(events[0].level, 'log');
  check('Button handler produces attributed console output');

  await enable();
  assert.equal(await count(), 1);
  await click();
  events = (await logs()).filter(event => event.message.includes('Style Lab script button clicked'));
  assert.equal(events.length, 2);
  assert.equal(await evaluate(`document.getElementById(${JSON.stringify(buttonID)}).dataset.clickCount`), '2');
  check('Repeated enable does not duplicate the button or handler');

  // Retain only the owned node to verify its detached handler is really removed.
  await evaluate(`globalThis.__eaDetachedProofButton = document.getElementById(${JSON.stringify(buttonID)})`);
  const disabled = await disable();
  assert.equal(disabled.phase, 'disabled');
  assert.equal(disabled.cleanupComplete, true);
  assert.equal(await count(), 0);
  await evaluate('__eaDetachedProofButton.click()');
  assert.equal((await logs()).filter(event => event.message.includes('Style Lab script button clicked')).length, 2);
  assert.deepEqual(await session.styles.remove(), launched.button);
  await screenshot('03-disabled.png');
  check('Disable removes the node, its detached handler, and independent stylesheet');

  await session.styles.apply(css);
  await enable();
  await click();
  assert.equal(await evaluate(`document.getElementById(${JSON.stringify(buttonID)}).dataset.clickCount`), '1');
  await enable(`${revision}-replacement`);
  assert.equal(await count(), 1);
  await click();
  assert.equal(await evaluate(`document.getElementById(${JSON.stringify(buttonID)}).dataset.clickCount`), '1');
  check('Re-enable and changed revision create one fresh instance');
  report.firstDocumentLogs = await logs();

  await session.reload();
  await initializeDocument();
  await enable();
  assert.equal(await count(), 1);
  await click();
  assert.equal(await evaluate(`document.getElementById(${JSON.stringify(buttonID)}).dataset.clickCount`), '1');
  check('Reinitialization after reload uses fresh document state', { automaticPackageReapplication: false });

  const failureID = randomUUID();
  const failure = await evaluate(`__eaOwnedProof.enable({extensionID:${JSON.stringify(failureID)},revision:'1',files:[{
    fileName:'failure.js', execute(ea) { const node = document.createElement('span'); node.id='owned-failure-proof';
      ea.onDispose(() => node.remove()); document.body.append(node); throw new Error('Expected fixture installation failure'); }
  }]})`);
  assert.equal(failure.phase, 'failed');
  assert.equal(failure.cleanupComplete, true);
  assert.equal(await evaluate("document.getElementById('owned-failure-proof') === null"), true);
  assert.equal(await count(), 1);
  check('Failed installation cleans registered resources without disabling another extension');

  await disable();
  await session.styles.remove();
  const finalLogs = await logs();
  await writeFile(path.join(output, 'extension-logs.json'), JSON.stringify({ schema: 1, sessionID: proofID, appKey: 'dev.extensionsanywhere.stylelab', events: finalLogs }) + '\n', { mode: 0o600 });
  await evaluate('__eaOwnedProof.dispose()');
  await session.stop();
  const integrity = await session.verify();
  assert.ok(integrity.unchanged);
  report.after = integrity.after;
  check('Fixture bundle contents and signing remain unchanged after shutdown');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  await session.stop();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidence: ${output}`);
  if (report.error) console.error(report.error);
}
