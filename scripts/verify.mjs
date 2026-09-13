import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureSession, fixtureBundle, root } from '../lib/fixture-session.mjs';
import { DEMO_BUTTON_ID, DEMO_LOG_MESSAGE } from '../lib/button-demo.mjs';

async function nodeID(cdp, selector) {
  const { root } = await cdp.call('DOM.getDocument');
  const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: root.nodeId, selector });
  assert.ok(nodeId, `${selector} must exist in our fixture`);
  return nodeId;
}

// Interaction tests are confined to the page of the fixture launched by FixtureSession.
async function click(session, selector) {
  const { model } = await session.cdp.call('DOM.getBoxModel', { nodeId: await nodeID(session.cdp, selector) });
  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  const position = { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4, button: 'left', clickCount: 1 };
  await session.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...position });
  await session.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position });
}

async function ping(session, expectedCount) {
  await click(session, '#signal-button');
  const { outerHTML } = await session.cdp.call('DOM.getOuterHTML', { nodeId: await nodeID(session.cdp, '#receipt') });
  assert.match(outerHTML, new RegExp(`${expectedCount} ${expectedCount === 1 ? 'ping' : 'pings'} sent\\.`));
}

async function demoCount(session) {
  const { root } = await session.cdp.call('DOM.getDocument');
  const { nodeIds } = await session.cdp.call('DOM.querySelectorAll', { nodeId: root.nodeId, selector: `#${DEMO_BUTTON_ID}` });
  return nodeIds.length;
}

async function capture(session, folder, name) {
  const { data } = await session.cdp.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(folder, `${name}.png`), Buffer.from(data, 'base64'));
}

export async function runProof({ log = console.log } = {}) {
  const folder = path.join(root, 'output', 'verification');
  await mkdir(folder, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(), status: 'running', fixture: fixtureBundle,
    scope: 'Owned, ad-hoc signed Electron fixture; no production-app compatibility claim.',
    signing: 'Hardened Runtime with allow-jit and disable-library-validation entitlements at build time.',
    checks: []
  };
  const check = (name, details = {}) => { report.checks.push({ name, passed: true, ...details }); log(`PASS ${name}`); };
  const session = new FixtureSession();
  try {
    const launched = await session.start();
    assert.ok(launched.signature.valid && launched.signature.hardenedRuntime && launched.signature.adHoc);
    report.before = launched.signature;
    const original = launched.button;
    assert.equal(original.background, 'rgb(41, 63, 49)');
    check('Signed fixture launches in a separate process', { pid: launched.pid, original });
    await ping(session, 1);
    await capture(session, folder, '01-original');
    check('Original button works');

    const neon = await readFile(path.join(root, 'styles/neon.css'), 'utf8');
    const applied = await session.styles.apply(neon);
    assert.deepEqual(applied, { background: 'rgb(213, 255, 112)', color: 'rgb(23, 34, 10)', radius: '24px' });
    await ping(session, 2);
    await capture(session, folder, '02-neon');
    check('External stylesheet changes the live button and preserves its click handler', { applied });

    const during = await session.verify();
    assert.ok(during.unchanged);
    check('Bundle content and code signature remain unchanged while styled');

    let reapplications = 0;
    session.styles.on('reapplied', () => reapplications++);
    const reloaded = await session.reload();
    assert.deepEqual(reloaded, applied);
    assert.ok(reapplications > 0);
    await ping(session, 1);
    await capture(session, folder, '03-after-reload');
    check('Reload automatically reapplies the stylesheet and the button still works');

    const lilac = await readFile(path.join(root, 'styles/lilac.css'), 'utf8');
    const replaced = await session.styles.apply(lilac);
    assert.deepEqual(replaced, { background: 'rgb(218, 201, 255)', color: 'rgb(53, 33, 92)', radius: '3px' });
    await capture(session, folder, '04-lilac');
    check('Replacing the stylesheet updates the same live app', { replaced });

    assert.deepEqual(await session.styles.remove(), original);
    await ping(session, 2);
    await capture(session, folder, '05-restored');
    check('Removing the stylesheet restores the original appearance and behavior');
    assert.deepEqual(await session.reload(), original);
    check('Removed styles stay removed after reload');

    assert.equal(await demoCount(session), 0);
    const messages = [];
    session.buttonDemo.on('console', record => messages.push(record));
    assert.deepEqual(await session.buttonDemo.install(), { present: true, clickCount: 0 });
    await session.buttonDemo.install();
    assert.equal(await demoCount(session), 1);
    await click(session, `#${DEMO_BUTTON_ID}`);
    assert.equal(await demoCount(session), 1);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message, DEMO_LOG_MESSAGE);
    assert.equal(messages[0].clickCount, 1);
    await click(session, `#${DEMO_BUTTON_ID}`);
    assert.equal(await demoCount(session), 1);
    assert.deepEqual(messages.map(record => record.clickCount), [1, 2]);
    await ping(session, 1);
    await capture(session, folder, '06-injected-button');
    check('External JS adds one new button with one console.log handler, even after repeated installation');
    assert.ok((await session.verify()).unchanged);
    check('Bundle and signature remain unchanged while injected JavaScript is active');

    await session.styles.apply(neon);
    assert.deepEqual(await session.reload(), applied);
    assert.equal(await demoCount(session), 1);
    await click(session, `#${DEMO_BUTTON_ID}`);
    assert.equal(await demoCount(session), 1);
    assert.deepEqual(messages.map(record => record.clickCount), [1, 2, 1]);
    await capture(session, folder, '07-button-after-reload');
    check('Reload reinstalls the JS button alongside CSS and its new handler logs once');
    assert.deepEqual(await session.buttonDemo.remove(), { present: false, clickCount: 0 });
    assert.equal(await demoCount(session), 0);
    assert.deepEqual(await session.styles.inspectButton(), applied);
    await ping(session, 1);
    check('Removing the injected button preserves the fixture button and independent CSS');
    await session.styles.remove();
    assert.deepEqual(await session.reload(), original);
    assert.equal(await demoCount(session), 0);
    report.consoleEvents = messages;
    check('Removed JavaScript button stays removed after reload');

    await session.stop();
    const final = await session.verify();
    assert.ok(final.unchanged);
    report.after = final.after;
    check('After shutdown, every bundle file and the CDHash match the baseline');
    report.status = 'passed';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    throw error;
  } finally {
    await session.stop();
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProof().then(report => console.log(`\n${report.checks.length} checks passed. Evidence: output/verification/`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
