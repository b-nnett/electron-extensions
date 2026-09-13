import test from 'node:test';
import assert from 'node:assert/strict';
import { failedLauncherEligibility, recoverObservedFailedLauncher } from '../scripts/lib/failed-launcher-preflight.mjs';

function evidence() {
  const launcherDirectory = '/Users/example/Library/Application Support/Extensions Anywhere/Launchers/fixed';
  const bundlePath = `${launcherDirectory}/Example Launcher.app`;
  const executable = `${bundlePath}/Contents/MacOS/ExtensionLauncher`;
  const helper = { pid: 100, bundlePath, executable, bundleIdentifier: 'dev.extensionsanywhere.launcher.example' };
  const target = { pid: 102, executable: '/Applications/Example.app/Contents/MacOS/Example', started: '1788902914.457598', uid: 501, ppid: 101 };
  const report = { slug: 'example', appKey: 'com.example.app', bundle: '/Applications/Example.app', brokerPid: 101,
    startedAt: '2026-09-08T21:28:33.452Z', finishedAt: '2026-09-08T21:28:52.661Z', errors: ['Control not ready'], processIdentity: target };
  const status = { ...report, phase: 'error', pid: null, updatedAt: report.finishedAt };
  return { profile: { slug: 'example', bundlePath: report.bundle, bundleIdentifier: report.appKey, executable: target.executable },
    helper, helperRegistrations: [{ ...helper }], targetRegistrations: [],
    identity: { pid: 100, started: '1788902913.000001', executable, uid: 501, ppid: 1 }, uid: 501,
    launcherDirectory, expectedLibraryPath: '/Users/example/Library/Application Support/Extensions Anywhere/library.json',
    config: { schemaVersion: 1, profile: 'example', targetBundlePath: report.bundle, targetBundleIdentifier: report.appKey,
      sessionsPath: `${launcherDirectory}/Sessions`, libraryPath: '/Users/example/Library/Application Support/Extensions Anywhere/library.json',
      brokerPath: `${bundlePath}/Contents/Resources/Runtime/scripts/dock-catalog-session.mjs`, nodePath: '/opt/homebrew/Cellar/node/26.5.0/bin/node' },
    info: { CFBundleIdentifier: helper.bundleIdentifier, CFBundleExecutable: 'ExtensionLauncher', LSUIElement: true, EALauncherSourceSHA256: 'a'.repeat(64) },
    session: { status, report }, canonicalPaths: true, signatureValid: true, brokerProcess: null, priorTargetProcess: null,
    observedAtMs: Date.parse('2026-09-08T22:00:00Z'), evidenceSHA256: 'same-snapshot' };
}

test('only a stopped target, absent broker, and verified failed wrapper lifetime are eligible', () => {
  const value = evidence();
  assert.deepEqual(failedLauncherEligibility(value), { eligible: true, reasons: [] });
  value.priorTargetProcess = { ...value.session.report.processIdentity, started: '1788903013.000001' };
  assert.equal(failedLauncherEligibility(value).eligible, true, 'a confirmed different PID lifetime is not the old target');
});

test('live, ambiguous, malformed or unrelated state blocks eligibility', () => {
  const cases = [
    v => { v.targetRegistrations = [{ pid: 200 }]; },
    v => { v.helperRegistrations.push({ ...v.helper, pid: 200 }); },
    v => { v.helperRegistrations[0].pid = 200; },
    v => { v.brokerProcess = { pid: 101 }; },
    v => { v.priorTargetProcess = { ...v.session.report.processIdentity }; },
    v => { v.priorTargetProcess = { pid: 102, started: 'different' }; },
    v => { v.session.status.phase = 'active'; },
    v => { delete v.session.report.finishedAt; },
    v => { v.session.report = null; },
    v => { v.session.status = null; },
    v => { v.identity.started = '1788902999.000001'; },
    v => { v.identity.uid = 502; },
    v => { v.config.brokerPath = '/tmp/other.mjs'; },
    v => { v.config.sessionsPath = '/tmp/Sessions'; },
    v => { v.config.libraryPath = '/tmp/library.json'; },
    v => { v.config.profile = 'different'; },
    v => { v.signatureValid = false; },
    v => { v.canonicalPaths = false; },
    v => { v.session.report.processIdentity = undefined; },
  ];
  for (const mutate of cases) {
    const value = evidence(); mutate(value);
    assert.equal(failedLauncherEligibility(value).eligible, false, mutate.toString());
  }
  assert.equal(failedLauncherEligibility(null).eligible, false);
});

test('no-launch recovery requires a known outcome, never just a missing target identity', () => {
  const value = evidence(); delete value.session.report.processIdentity;
  value.session.report.cleanup = { noAppLaunched: true };
  value.session.report.launchOutcomeUnknown = false;
  assert.equal(failedLauncherEligibility(value).eligible, true);
  value.session.report.launchOutcomeUnknown = true;
  assert.equal(failedLauncherEligibility(value).eligible, false);
});

function operations(changes = {}) {
  const value = evidence(); Object.assign(value, failedLauncherEligibility(value));
  const events = [], saves = [];
  return { events, saves, options: {
    inspect: async () => { events.push('inspect'); return structuredClone(value); },
    save: async result => { events.push('save'); saves.push(structuredClone(result)); },
    requestNormalTermination: async () => { events.push('normal-quit'); return true; },
    waitForExit: async () => { events.push('wait'); return { kernelAbsent: true, helperRegistryEmpty: true }; },
    ...changes
  } };
}

test('recovery persists evidence, revalidates, and only then requests one normal helper quit', async () => {
  const { events, saves, options } = operations();
  const result = await recoverObservedFailedLauncher(options);
  assert.deepEqual(events, ['inspect', 'save', 'inspect', 'save', 'normal-quit', 'save', 'wait', 'save']);
  assert.equal(result.outcome, 'closed-failed-helper');
  assert.equal(result.targetTerminationRequested, false);
  assert.equal(result.forceAttempted, false);
  assert.equal(saves[0].normalQuitAccepted, undefined);
  assert.ok(saves.at(-1).finishedAt);
});

test('changed evidence or helper PID lifetime aborts without termination', async () => {
  for (const change of [v => { v.evidenceSHA256 = 'changed'; }, v => { v.identity.started = '1788902913.000002'; }, v => { v.eligible = false; }]) {
    const { events, options } = operations(); let count = 0; const inspect = options.inspect;
    options.inspect = async () => { const value = await inspect(); if (++count === 2) change(value); return value; };
    await assert.rejects(recoverObservedFailedLauncher(options), /changed/);
    assert.equal(events.includes('normal-quit'), false);
  }
});

test('missing helper is a recorded no-op; blocked ownership never asks to quit', async () => {
  for (const value of [{ outcome: 'no-helper' }, { eligible: false, reasons: ['The original app is running.'] }]) {
    const { events, options } = operations({ inspect: async () => value });
    if (value.outcome) assert.equal((await recoverObservedFailedLauncher(options)).outcome, 'no-helper');
    else await assert.rejects(recoverObservedFailedLauncher(options), /original app/);
    assert.equal(events.includes('normal-quit'), false);
  }
});

test('declined or unfinished normal quit records failure without force', async () => {
  for (const failure of [
    { requestNormalTermination: async () => false },
    { waitForExit: async () => { throw new Error('Still running'); } }
  ]) {
    const { saves, options } = operations(failure);
    await assert.rejects(recoverObservedFailedLauncher(options));
    const result = saves.at(-1);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.forceAttempted, false);
    assert.equal(result.targetTerminationRequested, false);
  }
});

test('failure to save the pre-action observation prevents any termination', async () => {
  const { events, options } = operations({ save: async () => { throw new Error('Cannot save'); } });
  await assert.rejects(recoverObservedFailedLauncher(options), /Cannot save/);
  assert.equal(events.includes('normal-quit'), false);
});
