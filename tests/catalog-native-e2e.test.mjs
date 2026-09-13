import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { freshEvidenceDirectory, isTrackedIdentity, assertCurrentGreen, assertSessionOwnership, assertTerminalEvidence, flowPassed } from '../scripts/catalog-native-e2e.mjs';
import { requirePNG } from '../scripts/lib/catalog-e2e-ui.mjs';

const profile = { slug: 'example', bundleIdentifier: 'test.example', bundlePath: '/Applications/Example.app', executable: '/Applications/Example.app/Contents/MacOS/Example' };
const identity = { pid: 123, started: '1700000002.000001', executable: profile.executable, uid: process.getuid() };
const broker = { pid: 456, started: '1700000001.000001', executable: '/usr/local/bin/node', uid: process.getuid() };
const startedAt = '2023-11-14T22:13:21.010Z';
const integrity = { sha256: 'same-bundle', cdhash: 'same-signature', valid: true };
const computed = { 'background-color': 'rgb(22, 163, 74)', color: 'rgb(255, 255, 255)' };
function session() {
  const common = { slug: profile.slug, appKey: profile.bundleIdentifier, bundle: profile.bundlePath, brokerPid: broker.pid, processIdentity: { ...identity } };
  return { sessionDirectory: '/test/Sessions/NEW', status: { ...common, phase: 'active', revision: 1, computed, signatureUnchanged: true, enabledExtensionIDs: ['owned'] },
    report: { ...common, profile, startedAt, finishedAt: '2023-11-14T22:14:00.000Z', errors: [], unchanged: true, before: integrity, after: integrity,
      cleanup: { controllerDisconnected: true, targetTerminationRequested: false, stylesheetEndedWithApp: true, launchedAppLeftRunning: false },
      revisions: [{ number: 1, enabledExtensionIDs: ['owned'], stylesheetReadbackVerified: true, signatureUnchanged: true, appliedComputed: computed }] } };
}
function success() {
  return { errors: [], steps: [{ passed: true }], checks: Object.fromEntries(['initialLaunch', 'CSSReadback', 'disableRestore', 'reenable', 'promptShown', 'restartAccepted', 'restartRestored', 'menuLaunch', 'menuActivation', 'signatureUnchanged'].map(key => [key, true])),
    cleanup: { recordRemoved: true, dockRestored: true, sessionsVerified: true, evidenceCopied: true } };
}

test('cleanup never adopts an untracked new process or a recycled PID', () => {
  assert.equal(isTrackedIdentity({ ...identity }, [identity]), true);
  assert.equal(isTrackedIdentity({ ...identity, pid: 789 }, [identity]), false);
  assert.equal(isTrackedIdentity({ ...identity, started: '1700000010.000001' }, [identity]), false);
  assert.equal(isTrackedIdentity({ ...identity, uid: identity.uid + 1 }, [identity]), false);
  assert.equal(isTrackedIdentity(null, [identity]), false);
});

test('failure recovery requires this invocation’s new session and a matching fresh broker', () => {
  const attempt = { since: 1700000000000, exclude: '/test/Sessions/OLD' };
  assert.deepEqual(assertSessionOwnership(session(), profile, attempt, broker, broker.executable), identity);
  for (const alter of [
    value => { value.sessionDirectory = attempt.exclude; },
    value => { value.report.startedAt = '2023-11-14T22:13:19.000Z'; },
    value => { value.report.appKey = 'another.app'; },
    value => { value.status.processIdentity = { ...identity, started: '1700000003.000001' }; },
    value => { value.report.brokerPid = 999; }
  ]) { const value = session(); alter(value); assert.throws(() => assertSessionOwnership(value, profile, attempt, broker, broker.executable), /ownership/); }
  assert.throws(() => assertSessionOwnership(session(), profile, attempt, null, broker.executable), /ownership/);
  assert.throws(() => assertSessionOwnership(session(), profile, attempt, { ...broker, started: '1699999999.000001' }, broker.executable), /ownership/);
  assert.throws(() => assertSessionOwnership(session(), profile, { since: NaN }, broker, broker.executable), /ownership/);
});

test('green verification cannot reuse an earlier revision or another extension’s proof', () => {
  assert.doesNotThrow(() => assertCurrentGreen(session(), 'owned'));
  assert.throws(() => assertCurrentGreen(session(), 'another-record'), /current revision/);
  const value = session();
  value.report.revisions.push({ ...value.report.revisions[0], stylesheetReadbackVerified: false });
  assert.throws(() => assertCurrentGreen(value, 'owned'), /current revision/);
  value.status.revision = 2;
  assert.throws(() => assertCurrentGreen(value, 'owned'), /current revision/);
});

test('terminal evidence rejects incomplete cleanup, old identity, errors and changed signing', () => {
  const owned = { identity, broker, startedAt };
  const terminal = () => { const value = session(); value.status.phase = 'stopped'; return value; };
  assert.doesNotThrow(() => assertTerminalEvidence(terminal(), owned, profile, integrity));
  for (const alter of [
    value => { value.status.phase = 'stopping'; },
    value => { delete value.report.finishedAt; },
    value => { value.report.errors.push('restoration failed'); },
    value => { value.report.cleanup.launchedAppLeftRunning = true; },
    value => { value.report.cleanup.stylesheetRemovalUnresolved = true; },
    value => { value.report.cleanup.controllerDisconnected = false; },
    value => { value.report.processIdentity = { ...identity, started: '1700000003.000001' }; },
    value => { value.report.after = { ...integrity, sha256: 'changed' }; }
  ]) { const value = terminal(); alter(value); assert.throws(() => assertTerminalEvidence(value, owned, profile, integrity)); }
});

test('all cleanup and evidence failures block an otherwise successful flow', () => {
  assert.equal(flowPassed(success()), true);
  for (const key of ['removalVerificationError', 'sessionReadError', 'evidenceCopyError', 'quitError', 'appLeftRunning']) {
    const value = success(); value.cleanup[key] = true; assert.equal(flowPassed(value), false, key);
  }
  for (const key of ['sessionsVerified', 'evidenceCopied', 'dockRestored', 'recordRemoved']) {
    const value = success(); value.cleanup[key] = false; assert.equal(flowPassed(value), false, key);
  }
  const error = success(); error.errors.push({ message: 'native event evidence failed' }); assert.equal(flowPassed(error), false);
  const step = success(); step.steps.push({ passed: false }); assert.equal(flowPassed(step), false);
});

test('evidence directories must be new, contained and free of symlink parents', async t => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ea-e2e-evidence-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const base = path.join(temp, 'runs'); await mkdir(base);
  const output = path.join(base, 'date', 'new');
  assert.equal(await freshEvidenceDirectory(output, base), output);
  await assert.rejects(freshEvidenceDirectory(output, base), { code: 'EEXIST' });
  await assert.rejects(freshEvidenceDirectory(path.join(temp, 'outside'), base), /canonical run/);
  await assert.rejects(freshEvidenceDirectory(path.join(base, 'Target.APP', 'run'), base), /canonical run/);
  await symlink(temp, path.join(base, 'linked'));
  await assert.rejects(freshEvidenceDirectory(path.join(base, 'linked', 'escape'), base), /canonical directories/);
});

test('required screenshot validation rejects absent, empty, wrong format and symlinked evidence', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ea-e2e-png-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'menu.png');
  await assert.rejects(requirePNG(file), { code: 'ENOENT' });
  await writeFile(file, ''); await assert.rejects(requirePNG(file), /screenshot/);
  await writeFile(file, Buffer.alloc(30)); await assert.rejects(requirePNG(file), /PNG/);
  await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64'));
  assert.equal(await requirePNG(file), file);
  const link = path.join(temp, 'linked.png'); await symlink(file, link);
  await assert.rejects(requirePNG(link), /screenshot/);
});
