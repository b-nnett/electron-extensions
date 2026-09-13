import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureSession, root } from '../../lib/fixture-session.mjs';

// Real imported controller, with a fixed project-owned target and example.
// Vendor/native launch coverage is recorded by separate product-flow tests.
if (process.argv.length > 2) throw new Error('This proof accepts no target or source arguments.');
const output = path.join(root, 'output/release-review/2026-09-13', `imported-renderer-${randomUUID()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const session = new FixtureSession({ enableButtonDemo: false, enableImportedExtensions: true });
const id = randomUUID(), badID = randomUUID();
const text = await readFile(path.join(root, 'examples/stylelab-script-button/main.js'), 'utf8');
const selected = [{ extensionID: id, revision: 'initial', files: [{ fileName: 'main.js', text }] }];
const report = { passed: false, startedAt: new Date().toISOString(), checks: [], hashes: {} };
for (const file of ['lib/renderer-script-controller.mjs', 'lib/fixture-extension-runtime.mjs', 'lib/fixture-session.mjs']) {
  report.hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const count = async () => {
  const { root: document } = await session.cdp.call('DOM.getDocument');
  const { nodeIds } = await session.cdp.call('DOM.querySelectorAll', { nodeId: document.nodeId, selector: `.ea-stylelab-script-button` });
  return nodeIds.length;
};
const click = async () => {
  const { root: document } = await session.cdp.call('DOM.getDocument');
  const { nodeId } = await session.cdp.call('DOM.querySelector', { nodeId: document.nodeId, selector: `#ea-stylelab-script-button-${id}` });
  const { model } = await session.cdp.call('DOM.getBoxModel', { nodeId });
  const p = model.content;
  const position = { x: (p[0] + p[2] + p[4] + p[6]) / 4, y: (p[1] + p[3] + p[5] + p[7]) / 4, button: 'left', clickCount: 1 };
  await session.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...position });
  await session.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position });
};
try {
  report.before = await session.start();
  await session.extensions.sync(selected);
  await session.extensions.sync(selected);
  assert.equal(await count(), 1);
  await click();
  assert.equal(session.extensions.logs().filter(e => e.message === 'Style Lab script button clicked 1').length, 1);
  check('Imported script is idempotent and its real pointer handler logs once');

  const invalid = { extensionID: badID, revision: 'bad', files: [{ fileName: 'bad.js', text: 'const = ;' }] };
  await assert.rejects(session.extensions.sync([...selected, invalid]), error => {
    assert.equal(error.states.find(s => s.extensionID === id).phase, 'active');
    const failed = error.states.find(s => s.extensionID === badID);
    assert.equal(failed.phase, 'failed'); assert.equal(failed.cleanupComplete, true);
    return true;
  });
  assert.equal(await count(), 1);
  assert.ok(session.extensions.logs().some(e => e.extensionID === badID && e.fileName === 'bad.js' && e.message.includes('syntax error')));
  check('Syntax failure is attributed without disabling a healthy extension');
  await session.extensions.sync(selected);

  const handlerError = { extensionID: badID, revision: 'handler', files: [{ fileName: 'handler.js', text: `
    const button = document.getElementById('ea-stylelab-script-button-${id}');
    const fail = () => { throw new Error('Owned handler proof error'); };
    ea.onDispose(() => button.removeEventListener('click', fail));
    button.addEventListener('click', fail);
  ` }] };
  await session.extensions.sync([...selected, handlerError]);
  await click();
  for (let n = 0; n < 20 && !session.extensions.logs().some(e => e.message.includes('Owned handler proof error')); n++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(session.extensions.logs().some(e => e.extensionID === badID && e.fileName === 'handler.js' && e.level === 'error' && e.message.includes('Owned handler proof error')));
  check('Uncaught authored handler errors retain their extension and filename');
  await session.extensions.sync(selected);
  await session.reload();
  assert.equal(await count(), 1);
  await click();
  assert.equal(session.extensions.logs().filter(e => e.message === 'Style Lab script button clicked 1').length, 2);
  check('Automatic reload creates one fresh instance and keeps monotonic logs');
  await session.extensions.sync([]);
  assert.equal(await count(), 0);
  assert.ok(session.extensions.logs().some(e => e.message === 'Style Lab script button removed'));
  report.events = session.extensions.logs();
  await session.stop();
  assert.equal(session.extensionCleanupError, undefined);
  report.integrity = await session.verify();
  assert.equal(report.integrity.unchanged, true);
  check('Disable and stop remove registered resources with unchanged bundle and signing');
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await session.stop(); report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidence: ${output}`);
}
