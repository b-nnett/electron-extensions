import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FixtureExtensionRuntime, FIXTURE_RUNTIME_LIMITS } from '../lib/fixture-extension-runtime.mjs';

const id = '73D37907-0C9A-4E61-8D43-413501338998';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const file = (execute, fileName = 'main.js') => ({ fileName, execute });
const selected = (execute, revision = '1', extensionID = id) => ({ extensionID, revision, files: [file(execute)] });

test('matches importer case-insensitive JavaScript suffix while retaining the original log filename', async () => {
  const runtime = new FixtureExtensionRuntime();
  const state = await runtime.enable({ extensionID: id, revision: '1', files: [
    file((_ea, console) => console.log('Uppercase source'), 'scripts/Main.JS')
  ] });
  assert.equal(state.phase, 'active');
  assert.equal(runtime.logs()[0].fileName, 'scripts/Main.JS');
  await runtime.dispose();
});

test('owned renderer core adds no evaluator/Node dependency and construction has no effects', async () => {
  const source = await readFile(new URL('../lib/fixture-extension-runtime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s|\beval\s*\(|\bnew\s+Function\s*\(|Runtime\.evaluate|setBypassCSP/m);
  const fixture = await readFile(new URL('../fixture/main.cjs', import.meta.url), 'utf8');
  assert.match(fixture, /sandbox:\s*true/);
  assert.match(fixture, /contextIsolation:\s*true/);
  assert.match(fixture, /nodeIntegration:\s*false/);
  const runtime = new FixtureExtensionRuntime({ onLog() { assert.fail('No unsolicited log'); } });
  assert.deepEqual(runtime.logs(), []);
  assert.equal(runtime.state(id), null);
  assert.deepEqual(await runtime.dispose(), []);
});

test('lexical ea and console are frozen, bounded and attributed without replacing globals', async () => {
  const originalConsole = globalThis.console;
  const observed = [];
  const runtime = new FixtureExtensionRuntime({ onLog: event => observed.push(event) });
  let api;
  const state = await runtime.enable(selected((ea, console) => {
    api = ea;
    assert.deepEqual(Object.keys(ea).sort(), ['id', 'onDispose', 'signal']);
    assert.equal(ea.id, id);
    assert.equal(Object.isFrozen(ea), true);
    assert.equal(Object.isFrozen(console), true);
    assert.deepEqual(Object.keys(console).sort(), ['error', 'info', 'log', 'warn']);
    console.log('clicked', 2, true, null);
    console.info('info'); console.warn('warn'); console.error('error');
  }, 1));
  assert.equal(state.phase, 'active');
  assert.equal(state.revision, '1');
  assert.equal(globalThis.console, originalConsole);
  assert.deepEqual(observed.map(e => e.level), ['log', 'info', 'warn', 'error']);
  assert.deepEqual(observed.map(e => e.sequence), [1, 2, 3, 4]);
  for (const event of observed) {
    assert.equal(event.extensionID, id); assert.equal(event.fileName, 'main.js');
    assert.equal(event.revision, '1'); assert.ok(Number.isFinite(Date.parse(event.timestamp)));
  }
  assert.equal(observed[0].message, 'clicked 2 true null');
  assert.equal(api.signal.aborted, false);
  assert.equal((await runtime.disable(id)).cleanupComplete, true);
  assert.equal(api.signal.aborted, true);
});

test('same active revision is idempotent; replacing revision disposes first in reverse order', async () => {
  const runtime = new FixtureExtensionRuntime();
  const order = [];
  const execute = ea => {
    order.push('load');
    ea.onDispose(() => { assert.equal(ea.signal.aborted, true); order.push('dispose-first'); });
    ea.onDispose(() => order.push('dispose-last'));
  };
  assert.equal((await runtime.enable(selected(execute))).generation, 1);
  assert.equal((await runtime.enable(selected(() => assert.fail('Idempotent enable executes no replacement')))).generation, 1);
  assert.deepEqual(order, ['load']);
  assert.equal((await runtime.enable(selected(execute, '2'))).generation, 2);
  assert.deepEqual(order, ['load', 'dispose-last', 'dispose-first', 'load']);
  const disabled = await runtime.disable(id);
  assert.equal(disabled.phase, 'disabled'); assert.equal(disabled.cleanupComplete, true);
  await runtime.disable(id);
  assert.deepEqual(order, ['load', 'dispose-last', 'dispose-first', 'load', 'dispose-last', 'dispose-first']);
  assert.equal((await runtime.enable(selected(execute, '2'))).generation, 3);
  await runtime.dispose();
});

test('multiple files execute in manifest order and cleanup is attributed to its registering file', async () => {
  const runtime = new FixtureExtensionRuntime();
  const order = [];
  await runtime.enable({ extensionID: id, revision: 'digest:one', files: [
    file((ea, console) => { order.push('one'); ea.onDispose(() => console.info('one gone')); }, 'scripts/one.js'),
    file((ea, console) => { order.push('two'); ea.onDispose(() => console.info('two gone')); }, 'two.js')
  ] });
  await runtime.disable(id);
  assert.deepEqual(order, ['one', 'two']);
  assert.deepEqual(runtime.logs().map(e => [e.fileName, e.message]), [['two.js', 'two gone'], ['scripts/one.js', 'one gone']]);
});

test('load exception cleans registered resources while leaving other extensions active', async () => {
  const runtime = new FixtureExtensionRuntime();
  let resources = 0;
  await runtime.enable(selected(() => {}, '1', 'independent'));
  const failed = await runtime.enable(selected(ea => {
    resources++; ea.onDispose(() => resources--);
    throw new Error('expected installation failure');
  }));
  assert.equal(resources, 0);
  assert.equal(failed.phase, 'failed'); assert.equal(failed.cleanupComplete, true);
  assert.equal(failed.reloadBlocked, false);
  assert.equal(failed.lastError.stage, 'load');
  assert.equal(runtime.state('independent').phase, 'active');
  assert.match(runtime.logs().at(-1).message, /expected installation failure/);
  assert.equal((await runtime.enable(selected(() => {}, '2'))).phase, 'active');
  await runtime.dispose();
});

test('async initializer rejection is handled and asynchronous disposers are awaited', async () => {
  const runtime = new FixtureExtensionRuntime({ operationTimeoutMs: 100 });
  const order = [];
  const failed = await runtime.enable(selected(async ea => {
    ea.onDispose(async () => { await delay(5); order.push('cleanup finished'); });
    await delay(5);
    throw new Error('async failure');
  }));
  assert.equal(failed.phase, 'failed'); assert.equal(failed.cleanupComplete, true);
  assert.deepEqual(order, ['cleanup finished']);
  assert.match(runtime.logs().at(-1).message, /async failure/);
});

test('failed cleanup is sticky across repeated disable and blocks replacement without retrying callbacks', async () => {
  const runtime = new FixtureExtensionRuntime();
  const order = [];
  await runtime.enable(selected(ea => {
    ea.onDispose(() => order.push('other cleanup'));
    ea.onDispose(() => { order.push('failed cleanup'); throw new Error('resource release failed'); });
  }));
  for (const result of [await runtime.disable(id), await runtime.disable(id), await runtime.enable(selected(() => order.push('must not load'), '2'))]) {
    assert.equal(result.phase, 'failed'); assert.equal(result.cleanupComplete, false);
    assert.equal(result.reloadBlocked, true); assert.equal(result.revision, '1');
    assert.equal(result.lastError.stage, 'cleanup');
  }
  assert.deepEqual(order, ['failed cleanup', 'other cleanup']);
  assert.equal((await runtime.dispose())[0].cleanupComplete, false);
});

test('hanging async load reaches a failed state, aborts and cleans known resources without claiming full cleanup', async () => {
  const runtime = new FixtureExtensionRuntime({ operationTimeoutMs: 10 });
  let signal, cleaned = 0, capturedConsole;
  const failed = await runtime.enable(selected((ea, console) => {
    signal = ea.signal; capturedConsole = console;
    ea.onDispose(() => cleaned++);
    return new Promise(() => {});
  }));
  assert.equal(failed.phase, 'failed'); assert.equal(failed.cleanupComplete, false);
  assert.equal(failed.reloadBlocked, true); assert.equal(signal.aborted, true);
  assert.equal(cleaned, 1);
  const count = runtime.logs().length;
  capturedConsole.log('late unfinished script');
  assert.equal(runtime.logs().length, count);
  assert.equal((await runtime.disable(id)).cleanupComplete, false);
});

test('hanging cleanup remains uncertain and does not suppress other registered cleanup attempts', async () => {
  const runtime = new FixtureExtensionRuntime({ operationTimeoutMs: 10 });
  let cleaned = 0;
  await runtime.enable(selected(ea => {
    ea.onDispose(() => cleaned++);
    ea.onDispose(() => new Promise(() => {}));
  }));
  const failed = await runtime.disable(id);
  assert.equal(failed.phase, 'failed'); assert.equal(failed.cleanupComplete, false);
  assert.equal(failed.reloadBlocked, true); assert.equal(cleaned, 1);
  assert.equal((await runtime.disable(id)).cleanupComplete, false);
});

test('disable aborts a cooperative async initializer before its queued cleanup completes', async () => {
  const runtime = new FixtureExtensionRuntime();
  let mounted, cleaned = 0;
  const ready = new Promise(resolve => { mounted = resolve; });
  const loading = runtime.enable(selected(ea => {
    ea.onDispose(() => cleaned++);
    mounted();
    return new Promise(resolve => ea.signal.addEventListener('abort', resolve, { once: true }));
  }));
  await ready;
  const disabled = await runtime.disable(id);
  await loading;
  assert.equal(disabled.phase, 'disabled'); assert.equal(disabled.cleanupComplete, true);
  assert.equal(cleaned, 1);
});

test('one extension with an unresolved initializer does not hold another extension queue', async () => {
  const runtime = new FixtureExtensionRuntime({ operationTimeoutMs: 20 });
  const hanging = runtime.enable(selected(() => new Promise(() => {})));
  const healthy = await runtime.enable(selected(() => {}, '1', 'independent'));
  assert.equal(healthy.phase, 'active');
  assert.equal((await hanging).phase, 'failed');
  assert.equal(runtime.state('independent').phase, 'active');
  await runtime.dispose();
});

test('stale consoles and disposers cannot acquire resources or impersonate a replacement generation', async () => {
  const runtime = new FixtureExtensionRuntime();
  let firstConsole, firstEA;
  await runtime.enable(selected((ea, console) => { firstEA = ea; firstConsole = console; }));
  await runtime.disable(id);
  assert.throws(() => firstEA.onDispose(() => {}), /ended/);
  firstConsole.log('disabled');
  await runtime.enable(selected(() => {}, '2'));
  firstConsole.log('old generation');
  assert.deepEqual(runtime.logs(), []);
  await runtime.dispose();
});

test('logger failures and arbitrary object console arguments cannot break lifecycle', async () => {
  for (const onLog of [() => { throw new Error('sink failure'); }, async () => { throw new Error('async sink failure'); }]) {
    const runtime = new FixtureExtensionRuntime({ onLog });
    let inspected = false;
    const value = new Proxy({}, { get() { inspected = true; throw new Error('must not inspect'); }, ownKeys() { inspected = true; throw new Error('must not enumerate'); } });
    const state = await runtime.enable(selected((ea, console) => {
      console.log(value);
      ea.onDispose(() => console.info('cleaned'));
    }));
    assert.equal(state.phase, 'active'); assert.equal(inspected, false);
    assert.equal(runtime.logs()[0].message, '[Object]');
    assert.equal((await runtime.disable(id)).cleanupComplete, true);
    await delay(0);
  }
});

test('event/message byte limits allow a bounded native wrapper including pretty-print overhead', async () => {
  const runtime = new FixtureExtensionRuntime();
  await runtime.enable(selected((_ea, console) => {
    for (let index = 0; index < 900; index++) console.log('🙂'.repeat(2000), '\u0000'.repeat(4096), index);
  }));
  const events = runtime.logs();
  assert.ok(events.length > 0 && events.length <= FIXTURE_RUNTIME_LIMITS.logEvents);
  assert.ok(events[0].sequence > 1);
  for (const event of events) {
    assert.ok(Buffer.byteLength(event.message) <= 4096);
    assert.equal(event.message.includes('\ufffd'), false);
  }
  const wrapper = { schema: 1, appKey: 'dev.extensionsanywhere.stylelab', sessionID: id, events };
  assert.ok(Buffer.byteLength(JSON.stringify(wrapper, null, 2) + '\n') <= 512 * 1024);
  const copy = runtime.logs(); copy[0].message = 'external mutation';
  assert.notEqual(runtime.logs()[0].message, 'external mutation');
  await runtime.dispose();
});

test('event count and disposal registration counts are bounded', async () => {
  const runtime = new FixtureExtensionRuntime();
  await runtime.enable(selected((_ea, console) => { for (let i = 0; i < 600; i++) console.log(i); }));
  assert.equal(runtime.logs().length, 500);
  assert.equal(runtime.logs()[0].sequence, 101);
  let cleaned = 0;
  const failed = await runtime.enable(selected(ea => {
    for (let i = 0; i < 257; i++) ea.onDispose(() => cleaned++);
  }, '2'));
  assert.equal(failed.phase, 'failed'); assert.equal(failed.cleanupComplete, true);
  assert.equal(cleaned, 256);
});

test('source strings, unsafe filenames, inconsistent revisions and post-disposal enables are rejected', async () => {
  const runtime = new FixtureExtensionRuntime();
  for (const fileName of ['../main.js', '/main.js', 'scripts//main.js', 'https:main.js', 'main.mjs', 'main\n.js']) {
    await assert.rejects(runtime.enable({ extensionID: id, revision: '1', files: [file(() => {}, fileName)] }));
  }
  await assert.rejects(runtime.enable(selected('console.log("no source evaluation")')));
  await assert.rejects(runtime.enable(selected(() => {}, '1', 123)));
  await assert.rejects(runtime.enable(selected(() => {}, 'revision\ninvalid')));
  await runtime.enable(selected(() => {}));
  await assert.rejects(runtime.enable({ extensionID: id, revision: '1', files: [file(() => {}, 'different.js')] }), /revision/);
  assert.equal(runtime.state(id).phase, 'active');
  await runtime.dispose();
  await assert.rejects(runtime.enable(selected(() => {}, '2')), /disposed/);
});

test('removed extensions release record capacity without losing queued work or uncertain cleanup', async () => {
  const runtime = new FixtureExtensionRuntime();
  for (let index = 0; index < 80; index++) {
    const key = `removed-${index}`;
    await runtime.enable(selected(() => {}, '1', key));
    await runtime.disable(key);
    runtime.forgetDisabled();
    assert.equal(runtime.state(key), null);
  }
  const queued = runtime.enable(selected(() => {}, '1', 'pending'));
  runtime.forgetDisabled();
  assert.notEqual(runtime.state('pending'), null);
  assert.equal((await queued).phase, 'active');
  await runtime.enable(selected(ea => ea.onDispose(() => { throw new Error('not cleaned'); }), '1', 'uncertain'));
  await runtime.disable('uncertain');
  runtime.forgetDisabled();
  assert.equal(runtime.state('uncertain').reloadBlocked, true);
  await runtime.dispose();
});
