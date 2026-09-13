import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { RESERVE_BYTES, inspectZipMetadata, requireCapacity, runInstallerCommand, validateDestination, validateInstall } from '../scripts/install-catalog-app.mjs';

const entry = () => ({ bundlePath: '/Applications/Test App.app', install: { url: 'https://example.com/app.dmg', type: 'dmg', appName: 'Test App.app', sha256: null } });

test('installation destinations remain directly inside Applications', () => {
  assert.equal(validateDestination('/Applications/Test App.app'), '/Applications/Test App.app');
  for (const value of ['/Applications/../Test.app', '/Applications/Sub/Test.app', '/tmp/Test.app', '/Applications/.app', '/Applications/Test.app/']) {
    assert.throws(() => validateDestination(value));
  }
});

test('recipes require an exact app name, HTTPS, and explicit checksum policy', () => {
  assert.equal(validateInstall(entry()).sha256, null);
  for (const changes of [{ type: 'pkg' }, { appName: '../Test.app' }, { url: 'http://example.com/app.dmg' }, { url: 'https://user:password@example.com/app.dmg' }, { sha256: undefined }, { sha256: 'abc' }, { estimatedCompressedBytes: -1 }]) {
    const value = entry(); Object.assign(value.install, changes);
    assert.throws(() => validateInstall(value));
  }
  const value = entry(); value.install.sha256 = 'A'.repeat(64);
  assert.equal(validateInstall(value).sha256, 'a'.repeat(64));
});

test('disk planning reserves 8 GiB in addition to the requested allocation', () => {
  assert.doesNotThrow(() => requireCapacity(RESERVE_BYTES + 1024, 1024, 'copy'));
  assert.throws(() => requireCapacity(RESERVE_BYTES + 1023, 1024, 'copy'));
  assert.throws(() => requireCapacity(NaN, 0, 'copy'));
});

test('installer commands close stdin and answer only an observed standard license prompt', async () => {
  const eof = await runInstallerCommand(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => console.log('closed'))"], { timeout: 1000 });
  assert.equal(eof.stdout.trim(), 'closed');
  let accepted = 0;
  const fixture = "process.stdout.write('Do you agree to the terms of the license agreement? [Y/N]'); process.stdin.on('data', data => { console.log(data.toString().trim()); process.exit(); });";
  const result = await runInstallerCommand(process.execPath, ['-e', fixture], { timeout: 1000 }, () => accepted++);
  assert.equal(accepted, 1);
  assert.match(result.stdout, /\[Y\/N\]Y/);
  await runInstallerCommand(process.execPath, ['-e', fixture.replace('Do you agree to the terms of the license agreement? [Y/N]', 'Agree Y/N? ')], { timeout: 1000 }, () => accepted++);
  assert.equal(accepted, 2);
  const otherPrompt = "process.stdout.write('Delete user files? [Y/N]'); setTimeout(() => process.exit(), 50); process.stdin.on('data', () => process.exit(2));";
  await runInstallerCommand(process.execPath, ['-e', otherPrompt], { timeout: 1000 }, () => accepted++);
  assert.equal(accepted, 2);
});

test('timeout reaps an owned child even when it ignores SIGTERM', async () => {
  const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const started = Date.now();
  await assert.rejects(runInstallerCommand(process.execPath, ['-e', script], { timeout: 100 }), /aborted/i);
  assert.ok(Date.now() - started < 4000);
});

test('ZIP preflight accepts contained symlinks and rejects escaping paths before extraction', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'catalog-zip-test-'));
  const exec = promisify(execFile);
  const fixture = String.raw`
import stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    archive.writestr('Sample.app/Contents/main', 'fixture')
    link = zipfile.ZipInfo('Sample.app/Contents/link')
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    archive.writestr(link, sys.argv[2])
`;
  try {
    const safe = path.join(folder, 'safe.zip');
    await exec('/usr/bin/python3', ['-c', fixture, safe, 'main']);
    assert.equal((await inspectZipMetadata(safe)).entries, 2);
    const unsafe = path.join(folder, 'unsafe.zip');
    await exec('/usr/bin/python3', ['-c', fixture, unsafe, '../../../outside']);
    await assert.rejects(inspectZipMetadata(unsafe), /escapes extraction root/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
