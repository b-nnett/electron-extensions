import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeDiagnostics, DIAGNOSTIC_LIMITS, diagnosticArguments, guardDiagnosticTransport } from '../lib/runtime-diagnostics.mjs';
import { parseCatalogOptions, observePaintedCatalogControl, waitForOriginalCatalogControl } from '../scripts/dock-catalog-session.mjs';
import { parseChatGPTOptions, captureChatGPTDiagnostic } from '../scripts/dock-chatgpt-session.mjs';

const png = (bytes = 34) => {
  const image = Buffer.alloc(bytes);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  image.write('IHDR', 12); image.writeUInt32BE(1, 16); image.writeUInt32BE(1, 20);
  return image;
};
const temporary = async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'ea-private-diagnostics-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
};

test('only the explicit screenshot flag opts in; default CLI and extension metadata do not', () => {
  const ordinary = ['--library', '/tmp/library.json', '--output', '/tmp/session'];
  for (const [parse, args] of [[parseChatGPTOptions, ordinary], [parseCatalogOptions, ['--app', 'figma', ...ordinary]]]) {
    assert.equal(parse(args).diagnosticScreenshots, undefined);
    assert.equal(parse([...args, '--diagnostic-screenshots']).diagnosticScreenshots, true);
    assert.throws(() => parse([...args, '--diagnostic-screenshots', '--diagnostic-screenshots']));
    assert.throws(() => parse([...args, '--diagnostic-screenshots', 'true']));
  }
  assert.deepEqual(diagnosticArguments({ name: 'Hide Sidebar Voice Button' }), []);
  assert.deepEqual(diagnosticArguments({ name: 'Extensions Anywhere E2E — chatgpt' }), []);
  assert.deepEqual(diagnosticArguments({ diagnosticScreenshots: false }), []);
  assert.throws(() => diagnosticArguments({ diagnosticScreenshots: 'true' }), /boolean/);
});

test('ordinary catalog baseline, styled and restoration observations never capture renderer pixels', async t => {
  const output = await temporary(t);
  const diagnostics = new RuntimeDiagnostics({ output });
  const computed = { color: 'green', opacity: '1' };
  let captures = 0, targetChecks = 0;
  const styles = {
    screenshot: async () => { captures++; throw new Error('normal runtime tried to capture private content'); },
    settledControl: async () => ({ computed, observation: { stableSamples: 3 } }),
    control: async () => ({ computed, clip: { width: 1, height: 1 } }),
  };
  const original = await waitForOriginalCatalogControl(styles, { diagnostics, validateTarget: async () => { targetChecks++; } });
  assert.equal(original.observation.viewportCapturePrimed, false);
  for (const label of ['before', 'styled', 'restored']) {
    await diagnostics.capture(`revision-1-${label}.png`, () => styles.screenshot());
    assert.equal((await observePaintedCatalogControl(styles, { diagnostics })).observation.viewportCapturePrimed, false);
  }
  assert.equal(captures, 0); assert.equal(targetChecks, 1);
  assert.equal(diagnostics.summary.screenshotsEnabled, false);
  assert.deepEqual(await readdir(output), []);
});

test('ordinary ChatGPT before/after path performs no capture, DOM query, or output write', async t => {
  const output = await temporary(t);
  const diagnostics = new RuntimeDiagnostics({ output });
  let requests = 0;
  const forbidden = async () => { requests++; throw new Error('private renderer access'); };
  for (const phase of ['before', 'after']) {
    const file = await captureChatGPTDiagnostic({ diagnostics, styles: { frame: forbidden }, cdp: { call: forbidden }, phase, revision: 1 });
    assert.equal(file, null);
  }
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(output), []);
});

test('normal transport rejects accidental capture calls while permitting CSS readback', async () => {
  const calls = [];
  const transport = guardDiagnosticTransport({ call: async method => { calls.push(method); return {}; } }, new RuntimeDiagnostics());
  await assert.rejects(async () => transport.call('Page.captureScreenshot'), /disabled during normal runtime/);
  await transport.call('CSS.getStyleSheetText');
  assert.deepEqual(calls, ['CSS.getStyleSheetText']);
});

test('explicit ChatGPT diagnostics capture the stated viewport scope and write a private file', async t => {
  const output = await temporary(t);
  const diagnostics = new RuntimeDiagnostics({ enabled: true, output });
  const calls = [];
  const cdp = guardDiagnosticTransport({ call: async (method, params) => {
    calls.push({ method, params });
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1, clientHeight: 1 } };
    return { data: png().toString('base64') };
  } }, diagnostics);
  const file = await captureChatGPTDiagnostic({ diagnostics, styles: { frame: async () => {} }, cdp, phase: 'before', revision: 1 });
  assert.equal(file, 'revision-1-before.png');
  assert.deepEqual(await readFile(path.join(output, file)), png());
  assert.equal((await stat(path.join(output, file))).mode & 0o777, 0o600);
  assert.equal(diagnostics.summary.captures, 1);
  assert.match(diagnostics.summary.screenshotScope, /may contain private app content/);
  assert.deepEqual(calls[1].params, { format: 'png', captureBeyondViewport: false });
});

test('diagnostic capture limits stop collection before invoking the next capture', async t => {
  const output = await temporary(t);
  for (const image of [png(), png(DIAGNOSTIC_LIMITS.imageBytes)]) {
    const diagnostics = new RuntimeDiagnostics({ enabled: true, output });
    let captures = 0;
    const operation = async () => { captures++; return image; };
    const allowed = Math.min(DIAGNOSTIC_LIMITS.captures, Math.floor(DIAGNOSTIC_LIMITS.bytes / image.length));
    for (let i = 0; i < allowed; i++) await diagnostics.capture(null, operation);
    await assert.rejects(diagnostics.capture(null, operation), /capture limit/);
    assert.equal(captures, allowed);
    assert.ok(diagnostics.summary.capturedBytes <= DIAGNOSTIC_LIMITS.bytes);
  }
  assert.deepEqual(await readdir(output), []);
});

test('diagnostics preserve existing evidence and reject paths, symlinks and invalid images', async t => {
  const output = await temporary(t);
  const diagnostics = new RuntimeDiagnostics({ enabled: true, output });
  const file = path.join(output, 'revision-1-before.png');
  await writeFile(file, 'preserved');
  await assert.rejects(diagnostics.capture('revision-1-before.png', async () => png()), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), 'preserved');
  await symlink(file, path.join(output, 'revision-1-after.png'));
  await assert.rejects(diagnostics.capture('revision-1-after.png', async () => png()), { code: 'EEXIST' });
  await assert.rejects(diagnostics.capture('../outside.png', async () => png()), /filename/);
  await assert.rejects(diagnostics.capture('revision-2-before.png', async () => Buffer.from('not png')), /bounded PNG/);
});

test('overlapping diagnostic captures reserve their byte budget before collection', async t => {
  const diagnostics = new RuntimeDiagnostics({ enabled: true, output: await temporary(t) });
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  let started = 0;
  const pending = Array.from({ length: 8 }, () => diagnostics.capture(null, async () => { started++; await ready; return png(DIAGNOSTIC_LIMITS.imageBytes); }));
  await assert.rejects(diagnostics.capture(null, async () => { started++; return png(); }), /capture limit/);
  release();
  await Promise.all(pending);
  assert.equal(started, 8);
  assert.equal(diagnostics.summary.capturedBytes, DIAGNOSTIC_LIMITS.bytes);
});
