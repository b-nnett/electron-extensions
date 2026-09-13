import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nativeProcessIdentityHelperPath } from '../lib/process-identity.mjs';

const macOS = { skip: process.platform !== 'darwin' };
const helper = nativeProcessIdentityHelperPath();
const environment = { PATH: '/usr/bin:/bin' };

test('native identity CLI reads only this owned process with no developer-tool environment', macOS, () => {
  const records = JSON.parse(execFileSync(helper, [JSON.stringify([process.pid])], { env: environment, encoding: 'utf8' }));
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'ok');
  assert.equal(records[0].pid, process.pid);
  assert.equal(records[0].uid, process.getuid());
  assert.equal(records[0].ppid, process.ppid);
  assert.equal(realpathSync(records[0].executable), realpathSync(process.execPath));
  assert.match(records[0].started, /^[1-9]\d*\.\d{6}$/);
});

test('native identity CLI rejects malformed and unbounded inputs without stdout records', macOS, () => {
  const invalid = [[], ['[]'], ['{}'], ['[true]'], ['[0]'], ['[-1]'], ['[1.5]'], ['[2147483648]'], ['["1"]'],
    ['[1,1]'], ['[1]', '[2]'], ['not-json'], [JSON.stringify(Array.from({ length: 8193 }, (_, index) => index + 1))],
    [' '.repeat(128 * 1024) + '[1]']];
  for (const args of invalid) {
    const result = spawnSync(helper, args, { env: environment, encoding: 'utf8' });
    assert.equal(result.error, undefined, `native helper must be built: ${result.error}`);
    assert.equal(result.status, 64, `input ${args[0]?.slice(0, 40)} must be rejected`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: ProcessIdentity /);
  }
});

test('native identity CLI confirms absence after an owned child exits normally', macOS, () => {
  const child = spawnSync(process.execPath, ['-e', ''], { env: environment, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.ok(child.pid > 0);
  const records = JSON.parse(execFileSync(helper, [JSON.stringify([child.pid])], { env: environment, encoding: 'utf8' }));
  assert.deepEqual(records, [{ pid: child.pid, status: 'absent', errno: 3, confirmedBy: 'kill-0' }]);
});

function relocatedRuntime(t) {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ea-native-identity-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const runtime = path.join(temporary, 'Moved Manager.app/Contents/Resources/Runtime');
  mkdirSync(path.join(runtime, 'lib'), { recursive: true });
  mkdirSync(path.join(runtime, 'native'), { recursive: true });
  const modulePath = path.join(runtime, 'lib/process-identity.mjs');
  copyFileSync(fileURLToPath(new URL('../lib/process-identity.mjs', import.meta.url)), modulePath);
  return { runtime, modulePath };
}

test('relocated packaged module executes its adjacent native reader', macOS, async t => {
  const { runtime, modulePath } = relocatedRuntime(t);
  const destination = path.join(runtime, 'native/ProcessIdentity');
  copyFileSync(helper, destination);
  chmodSync(destination, 0o755);
  const module = await import(pathToFileURL(modulePath));
  assert.equal(module.nativeProcessIdentityHelperPath(), destination);
  const result = await module.getProcessIdentity(process.pid);
  assert.equal(result.pid, process.pid);
  assert.equal(result.executable, realpathSync(process.execPath));
});

test('missing or symlinked native reader fails closed without an interpreter fallback', macOS, async t => {
  const { runtime, modulePath } = relocatedRuntime(t);
  const module = await import(pathToFileURL(modulePath));
  await assert.rejects(module.getProcessIdentity(process.pid), { code: 'NATIVE_READER_FAILED' });
  symlinkSync(helper, path.join(runtime, 'native/ProcessIdentity'));
  await assert.rejects(module.getProcessIdentity(process.pid), { code: 'NATIVE_READER_FAILED' });
});
