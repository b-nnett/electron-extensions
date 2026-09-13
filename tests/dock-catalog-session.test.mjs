import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseCatalogOptions, verifyLoopbackOwnership, runCatalogDock, classifyCatalogDisconnect, catalogLaunchSummary, catalogNativeHelperPath } from '../scripts/dock-catalog-session.mjs';

test('packaged catalog LaunchServices helper stays inside Runtime with checkout-only CLI fallback', () => {
  const runtime = '/Applications/Extensions Anywhere.app/Contents/Resources/Runtime';
  assert.equal(catalogNativeHelperPath(runtime), `${runtime}/native/CatalogAppLaunch`);
  assert.equal(catalogNativeHelperPath('/tmp/checkout'), '/tmp/checkout/dist/Extensions Anywhere.app/Contents/Resources/CatalogAppLaunch');
  for (const invalid of ['relative', '/tmp/../other', '/Applications/Extensions Anywhere.app/Contents/Resources',
    '/Applications/Extensions Anywhere.app/Contents/Resources/Other']) assert.throws(() => catalogNativeHelperPath(invalid));
});

test('catalog CLI accepts only one fixed slug and absolute library/output paths', () => {
  assert.deepEqual(parseCatalogOptions(['--app', 'figma', '--library', '/tmp/library.json', '--output', '/tmp/new']),
    { app: 'figma', library: '/tmp/library.json', output: '/tmp/new' });
  for (const args of [[], ['--app', '/Applications/Figma.app'], ['--endpoint', 'ws://127.0.0.1:1'],
    ['--app', 'figma', '--app', 'slack', '--library', '/tmp/a', '--output', '/tmp/b'],
    ['--app', 'figma', '--library', 'relative.json', '--output', '/tmp/new']]) assert.throws(() => parseCatalogOptions(args));
});

test('loopback ownership rejects wildcard binds, other processes and malformed ownership metadata', () => {
  assert.equal(verifyLoopbackOwnership('p123\nn127.0.0.1:8000\n', 123, 8000), true);
  for (const input of ['', 'p123\nn*:8000\n', 'p124\nn127.0.0.1:8000\n', 'n127.0.0.1:8000\n',
    'p123\nn127.0.0.1:8000\np124\nn127.0.0.1:8000\n', 'p123\nn[::1]:8000\n']) assert.equal(verifyLoopbackOwnership(input, 123, 8000), false);
});

test('unknown profile writes a failed bounded session without app work and preserves existing evidence', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'catalog-session-unit-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const options = { app: 'not-in-the-curated-catalog', library: path.join(folder, 'unused.json'), output: path.join(folder, 'session') };
  const report = await runCatalogDock(options);
  assert.match(report.errors[0], /no curated/); assert.equal(report.cleanup.noAppLaunched, true);
  assert.equal(report.launchRequested, false); assert.equal(report.launchOutcomeUnknown, false);
  assert.equal(report.cleanup.targetTerminationRequested, false);
  const status = JSON.parse(await readFile(path.join(options.output, 'status.json')));
  assert.equal(status.phase, 'error'); assert.equal(status.pid, null); assert.equal(status.heartbeatVersion, 1);
  assert.equal(status.updatedAt, status.heartbeatAt);
  const original = await readFile(path.join(options.output, 'report.json'), 'utf8');
  await assert.rejects(runCatalogDock(options), /new session/);
  assert.equal(await readFile(path.join(options.output, 'report.json'), 'utf8'), original);
});

test('native ownership marker and its in-flight atomic update do not race fresh broker startup', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'catalog-marker-unit-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const options = { app: 'not-in-the-curated-catalog', library: path.join(folder, 'unused.json'), output: path.join(folder, 'session') };
  await mkdir(options.output);
  const names = ['.ea-session-owner.json', '.ea-session-owner-01234567-89AB-CDEF-0123-456789ABCDEF.tmp'];
  for (const name of names) await writeFile(path.join(options.output, name), 'native metadata');
  const report = await runCatalogDock(options);
  assert.match(report.errors[0], /no curated/);
  assert.equal(report.cleanup.noAppLaunched, true);
  for (const name of names) assert.equal(await readFile(path.join(options.output, name), 'utf8'), 'native metadata');
});

const identity = { pid: 123, started: '1789000000.123456', executable: '/Applications/Example.app/Contents/MacOS/Example', uid: 501, ppid: 1 };

function disconnectProbe(readIdentity) {
  let elapsed = 0;
  const waits = [];
  return { options: { readIdentity, clock: () => elapsed, wait: async ms => { waits.push(ms); elapsed += ms; } }, waits };
}

test('normal quit disconnect waits briefly for exact kernel absence instead of assuming exit', async () => {
  let calls = 0;
  const probe = disconnectProbe(async pid => { assert.equal(pid, identity.pid); return ++calls < 3 ? { ...identity } : null; });
  const outcome = await classifyCatalogDisconnect(identity, probe.options);
  assert.equal(outcome.originalProcessEnded, true); assert.equal(outcome.sameProcessAlive, false);
  assert.equal(outcome.reason, 'kernel-confirmed-absence'); assert.equal(outcome.waitedMs, 200);
  assert.deepEqual(probe.waits, [100, 100]); assert.equal(calls, 3);
});

test('still-running original app keeps removal unresolved after a bounded wait', async () => {
  let calls = 0;
  const probe = disconnectProbe(async () => { calls++; return { ...identity }; });
  const outcome = await classifyCatalogDisconnect(identity, probe.options);
  assert.equal(outcome.originalProcessEnded, false); assert.equal(outcome.sameProcessAlive, true);
  assert.equal(outcome.reason, 'same-process-still-running'); assert.equal(outcome.waitedMs, 1500);
  assert.equal(calls, 16); assert.equal(probe.waits.reduce((a, b) => a + b, 0), 1500);
});

test('unreadable or changed ownership is never treated as exit, including ENOENT', async () => {
  for (const reader of [async () => { throw Object.assign(new Error('path unreadable; absence not confirmed'), { code: 'ENOENT' }); },
    async () => ({ ...identity, uid: 502 }), async () => ({ ...identity, executable: '/other/executable' }), async () => ({ pid: 123 })]) {
    const probe = disconnectProbe(reader);
    const outcome = await classifyCatalogDisconnect(identity, probe.options);
    assert.equal(outcome.originalProcessEnded, false); assert.equal(outcome.sameProcessAlive, null);
    assert.equal(outcome.reason, 'identity-unresolved'); assert.ok(outcome.waitedMs <= 1500);
  }
});

test('confirmed PID reuse ends only the old process identity without touching its replacement', async () => {
  const requests = [];
  const probe = disconnectProbe(async pid => { requests.push(pid); return { ...identity, started: '1789000001.000001' }; });
  const outcome = await classifyCatalogDisconnect(identity, probe.options);
  assert.equal(outcome.originalProcessEnded, true); assert.equal(outcome.reason, 'kernel-confirmed-pid-reuse');
  assert.deepEqual(requests, [123]); assert.deepEqual(probe.waits, []);
});

test('failed LaunchServices callback retains unknown launch outcome rather than claiming no app launched', () => {
  assert.deepEqual(catalogLaunchSummary({ requested: true, identityVerified: false }),
    { launchRequested: true, launchOutcomeUnknown: true, noAppLaunched: false });
  assert.deepEqual(catalogLaunchSummary({ requested: false, identityVerified: false }),
    { launchRequested: false, launchOutcomeUnknown: false, noAppLaunched: true });
  assert.deepEqual(catalogLaunchSummary({ requested: true, identityVerified: true }),
    { launchRequested: true, launchOutcomeUnknown: false, noAppLaunched: false });
  assert.deepEqual(catalogLaunchSummary({ requested: true, identityVerified: false, failedBeforeStart: true }),
    { launchRequested: true, launchOutcomeUnknown: false, noAppLaunched: true });
});
