import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createProcessIdentityReader, getProcessIdentity, nativeProcessIdentityHelperPath, parseCurrentUserPids, sameProcessIdentity } from '../lib/process-identity.mjs';

const executable = '/Applications/MongoDB Compass.app/Contents/MacOS/MongoDB Compass';
const native = (pid = 42, changes = {}) => ({ pid, status: 'ok', executable, started: '1788730000.123456', uid: 501, ppid: 1, ...changes });
const synthetic = (records, options = {}) => createProcessIdentityReader({
  readBatch: async pids => pids.map(pid => records.get(pid)),
  listPids: async () => [...records.keys()], canonicalize: async value => path.normalize(value), uid: 501, ...options
});

test('packaged native reader lookup is relocatable and cannot fall back out of an app', () => {
  assert.equal(nativeProcessIdentityHelperPath('/Applications/Extensions Anywhere.app/Contents/Resources/Runtime'),
    '/Applications/Extensions Anywhere.app/Contents/Resources/Runtime/native/ProcessIdentity');
  assert.equal(nativeProcessIdentityHelperPath('/tmp/owned checkout'),
    '/tmp/owned checkout/dist/Extensions Anywhere.app/Contents/Resources/Runtime/native/ProcessIdentity');
  for (const root of ['relative', '/tmp/../other', '/tmp/Broken.app/Resources', '/Applications/Other.APP']) {
    assert.throws(() => nativeProcessIdentityHelperPath(root));
  }
});

test('negative macOS system UIDs are accepted and excluded from current-user inventory', async () => {
  const stdout = '  633    -2\n 1179    -2\n    1     0\n   42   501\n   43   502\n';
  assert.deepEqual(parseCurrentUserPids(stdout, 501), [42]);
  const reader = synthetic(new Map([[42, native()]]), {
    listPids: async uid => parseCurrentUserPids(stdout, uid),
    readBatch: async pids => {
      assert.deepEqual(pids, [42]);
      return [native()];
    }
  });
  const inventory = await reader.findProcessesByExecutable(executable);
  assert.deepEqual(inventory.matches.map(item => item.pid), [42]);
  assert.deepEqual(inventory.unresolved, []);
});

test('PID inventory parser still rejects malformed or unexpected rows', () => {
  for (const stdout of ['', 'pid uid\n42 501', '42 nobody', '42 --2', '42 501 extra', '42 501\nmalformed']) {
    assert.throws(() => parseCurrentUserPids(stdout, 501), { code: 'INVALID_INVENTORY' });
  }
});

test('kernel path identifies a process despite a shortened mutable process title', async () => {
  const reader = synthetic(new Map([[42, native(42, { comm: 'MongoDB Compass' })]]));
  assert.deepEqual(await reader.getProcessIdentity(42), { pid: 42, executable, started: '1788730000.123456', uid: 501, ppid: 1 });
  const inventory = await reader.findProcessesByExecutable(executable);
  assert.equal(inventory.matches.length, 1);
  assert.deepEqual(inventory.unresolved, []);
  assert.equal(inventory.scope, 'current-user');
});

test('only explicitly confirmed absence becomes null', async () => {
  const reader = synthetic(new Map([[42, { pid: 42, status: 'absent', errno: 3, confirmedBy: 'kill-0' }]]));
  assert.equal(await reader.getProcessIdentity(42), null);
  const unconfirmed = synthetic(new Map([[42, { pid: 42, status: 'absent' }]]));
  await assert.rejects(unconfirmed.getProcessIdentity(42), { code: 'INVALID_RESPONSE' });
});

test('permission and ambiguous libproc failures throw and remain unresolved in inventory', async () => {
  for (const errno of [1, 13, 0, 3]) {
    const reader = synthetic(new Map([[42, { pid: 42, status: 'error', code: 'LOOKUP_DENIED', errno }]]));
    await assert.rejects(reader.getProcessIdentity(42), { code: 'LOOKUP_DENIED', errno });
    const inventory = await reader.findProcessesByExecutable(executable);
    assert.deepEqual(inventory.matches, []);
    assert.equal(inventory.unresolved[0].errno, errno);
  }
});

test('native execution failures cannot be mistaken for process absence', async () => {
  const reader = synthetic(new Map([[42, native()]]), { readBatch: async () => { throw new Error('reader timed out'); } });
  await assert.rejects(reader.getProcessIdentity(42), /reader timed out/);
  await assert.rejects(reader.findProcessesByExecutable(executable), /reader timed out/);
});

test('PID reuse, executable changes, and user changes fail identity comparison', async () => {
  const identity = await synthetic(new Map([[42, native()]])).getProcessIdentity(42);
  assert.equal(sameProcessIdentity(identity, { ...identity }), true);
  for (const change of [{ pid: 43 }, { started: '1788730000.123457' }, { executable: '/usr/bin/other' }, { uid: 502 }]) {
    assert.equal(sameProcessIdentity(identity, { ...identity, ...change }), false);
  }
  assert.equal(sameProcessIdentity(identity, null), false);
  assert.equal(sameProcessIdentity({}, {}), false);
});

test('native detection of a mid-inspection PID change remains an error', async () => {
  const reader = synthetic(new Map([[42, { pid: 42, status: 'error', code: 'PROCESS_CHANGED' }]]));
  await assert.rejects(reader.getProcessIdentity(42), { code: 'PROCESS_CHANGED' });
});

test('canonical paths match exact executables, not basename or prefix lookalikes', async () => {
  const canonical = async value => path.normalize(value).replace('/Alias.app/', '/Real.app/');
  const reader = synthetic(new Map([
    [42, native(42, { executable: '/Alias.app/Contents/MacOS/app' })],
    [43, native(43, { executable: '/Real.app/Contents/MacOS/app Helper' })]
  ]), { canonicalize: canonical });
  const inventory = await reader.findProcessesByExecutable('/Real.app/Contents/MacOS/./app');
  assert.deepEqual(inventory.matches.map(p => p.pid), [42]);
  assert.equal(inventory.matches[0].executable, '/Real.app/Contents/MacOS/app');
});

test('unresolvable kernel path is not reported as exit', async () => {
  const reader = synthetic(new Map([[42, native()]]), { canonicalize: async () => { throw new Error('ENOENT'); } });
  await assert.rejects(reader.getProcessIdentity(42), { code: 'EXECUTABLE_PATH_UNRESOLVED' });
});

test('rejects malformed or partial identity data and invalid PID inputs', async () => {
  for (const changes of [{ started: 'today' }, { executable: 'MongoDB Compass' }, { pid: 43 }, { uid: -1 }]) {
    await assert.rejects(synthetic(new Map([[42, native(42, changes)]])).getProcessIdentity(42));
  }
  const reader = synthetic(new Map([[42, native()]]));
  for (const pid of [0, -1, 1.5, '42', 2147483648]) await assert.rejects(reader.getProcessIdentity(pid), TypeError);
  await assert.rejects(reader.findProcessesByExecutable('MongoDB Compass'), TypeError);
});

test('live macOS smoke reads the current test process with a stable start identity', { skip: process.platform !== 'darwin' }, async () => {
  const first = await getProcessIdentity(process.pid);
  const second = await getProcessIdentity(process.pid);
  assert.equal(first.pid, process.pid);
  assert.equal(first.executable, await realpath(process.execPath));
  assert.equal(first.uid, process.getuid());
  assert.equal(sameProcessIdentity(first, second), true);
});

test('live macOS native batch finds the current test PID with an owned-process-only inventory', { skip: process.platform !== 'darwin' }, async () => {
  const expected = await getProcessIdentity(process.pid);
  const reader = createProcessIdentityReader({ listPids: async () => [process.pid] });
  const inventory = await reader.findProcessesByExecutable(process.execPath);
  assert.equal(inventory.scope, 'current-user');
  assert.equal(inventory.executable, await realpath(process.execPath));
  assert.equal(sameProcessIdentity(expected, inventory.matches.find(item => item.pid === process.pid)), true);
  assert.deepEqual(inventory.unresolved, []);
});
