import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedger, renderTable, mergeVerifiedManualMetadata } from '../scripts/update-e2e-ledger.mjs';

const slugs = ['figma', 'bruno', 'claude', ...Array.from({ length: 47 }, (_, index) => `app-${index}`)];
const savedIntegrity = { valid: true, cdhash: 'a'.repeat(40), sha256: 'b'.repeat(64), files: 10 };
function ledger() {
  return { rows: slugs.map(slug => ({ slug, app: slug, version: 'current-version', build: 'current-build',
    bundlePath: `/Applications/${slug}.app`, bundleIdentifier: `example.${slug}`,
    executable: `/Applications/${slug}.app/Contents/MacOS/${slug}`, currentStatus: 'pending',
    nativeInitialLaunch: 'pending', CSSReadback: 'pending', visual: 'pending', disableRestore: 'pending',
    promptShown: 'pending', restartAccepted: 'pending', newRuntimeHealthy: 'pending', menuLaunch: 'pending',
    signatureUnchanged: 'pending', cleanup: 'pending', specialSetup: ['Preserved setup'], evidence: [], errors: [] })) };
}
function background(slug = 'bruno', number = 1, overrides = {}) {
  const row = ledger().rows.find(item => item.slug === slug);
  const startedAt = `2026-09-08T20:0${number}:00Z`, finishedAt = `2026-09-08T20:0${number}:30Z`;
  const identity = { pid: 1234, executable: row.executable, started: ((Date.parse(startedAt) + 1000) / 1000).toFixed(6), uid: 501 };
  const trial = { evidence: `output/e2e-50/2026-09-08/live/${slug}/background-trial-${number}/result.json`,
    report: { slug, profile: { slug, bundlePath: row.bundlePath, bundleIdentifier: row.bundleIdentifier,
      executable: row.executable, runtimeSupported: true, transport: 'pipe', target: { selector: 'button#test' } },
    startedAt, finishedAt,
    steps: [{ name: 'open through production manager', passed: true }],
    checks: Object.fromEntries(['nativeOpen', 'currentCSS', 'nativeHealthy', 'disableRestore', 'reenable', 'signatureUnchanged'].map(key => [key, true])),
    errors: [], cleanup: Object.fromEntries(['recordRemoved', 'dockRestored', 'removalRestored', 'sessionVerified', 'evidenceCopied'].map(key => [key, true])),
    before: savedIntegrity, after: savedIntegrity, processIdentity: identity,
    automatedFlowPassed: false, backgroundCSSPassed: true, visualReview: 'pending', status: 'background-css-awaiting-visual-review', ...overrides },
    brokerReports: terminalCopies(row, identity, startedAt, finishedAt) };
  return trial;
}
function terminalCopies(row, identity, startedAt, finishedAt) {
  const common = { slug: row.slug, bundle: row.bundlePath, appKey: row.bundleIdentifier, brokerPid: identity.pid + 100,
    processIdentity: identity, startedAt };
  return [{ ...common, version: 'older-tested-version', build: 'older-tested-build', errors: [], revisions: [], finishedAt,
    before: savedIntegrity, during: savedIntegrity, after: savedIntegrity, unchanged: true,
    cleanup: { controllerDisconnected: true, targetTerminationRequested: false, stylesheetRemoved: true, launchedAppLeftRunning: false } },
  { ...common, phase: 'stopped', pid: null, updatedAt: finishedAt }];
}
const merge = (value, attempts) => mergeLedger(value, { canonicalSlugs: slugs, backgroundAttempts: attempts, now: '2026-09-08T21:00:00Z' });

test('successful background checks awaiting review stay partial and cannot change full E2E flags', () => {
  const original = ledger(); const result = merge(original, [background()]);
  const row = result.ledger.rows.find(item => item.slug === 'bruno');
  assert.equal(row.backgroundVerification.status, 'partial-awaiting-visual-review');
  assert.equal(row.backgroundVerification.countsTowardFullE2E, false);
  assert.equal(row.backgroundVerification.checks.CSSReadback, 'pass');
  assert.equal(row.backgroundVerification.visual, 'pending');
  for (const key of ['currentStatus', 'CSSReadback', 'visual', 'promptShown', 'restartAccepted', 'newRuntimeHealthy', 'menuLaunch']) {
    assert.equal(row[key], original.rows.find(item => item.slug === 'bruno')[key]);
  }
  assert.equal(result.ledger.counts.passed, 0);
  assert.equal(result.ledger.backgroundCounts.awaitingVisualReview, 1);
});

test('accepted background images still add zero full E2E passes and preserve current version', () => {
  const result = merge(ledger(), [background('bruno', 1, { visualReview: { accepted: true, note: 'Agent inspected crops.' } })]);
  const row = result.ledger.rows.find(item => item.slug === 'bruno');
  assert.equal(row.backgroundVerification.status, 'partial-verified');
  assert.equal(row.backgroundVerification.testedVersion, 'older-tested-version');
  assert.equal(row.version, 'current-version'); assert.equal(row.build, 'current-build');
  assert.equal(row.currentStatus, 'pending'); assert.equal(row.backgroundVerification.menuLaunch, 'pending');
  assert.equal(row.backgroundVerification.restart, 'pending'); assert.equal(result.ledger.counts.passed, 0);
});

test('full renderer image scope requires explicit broker capture metadata and never establishes native window proof', () => {
  const trial = background();
  trial.brokerReports[0].revisions = [{ screenshots: { before: 'before.png', styled: 'styled.png' },
    screenshotScope: 'Complete visible renderer; native window chrome is captured separately by the E2E runner.' },
    { enabledExtensionIDs: [], cssBytes: 0 }];
  const complete = merge(ledger(), [trial]).ledger.rows.find(item => item.slug === 'bruno').backgroundVerification;
  assert.equal(complete.backgroundImageScope, 'Full renderer images; native window chrome is not included.');
  assert.equal(complete.fullAppVisual, 'pending');
  trial.brokerReports[0].revisions.push({ screenshots: { before: 'crop.png' }, screenshotScope: 'Control crop only.' });
  const mixed = merge(ledger(), [trial]).ledger.rows.find(item => item.slug === 'bruno').backgroundVerification;
  assert.match(mixed.backgroundImageScope, /earlier trials may contain control crops/);
});

test('existing manual full pass remains accepted after a failing background trial', () => {
  const original = ledger(); const manual = original.rows.find(item => item.slug === 'figma');
  Object.assign(manual, { currentStatus: 'pass', CSSReadback: 'pass', visual: 'pass', promptShown: 'pass',
    restartAccepted: 'pass', newRuntimeHealthy: 'pass', menuLaunch: 'pass', evidence: ['output/e2e-50/2026-09-08/live/figma/result.json'] });
  const failed = background('figma', 1, { backgroundCSSPassed: false, status: 'background-css-failed', errors: [{ message: 'Control unavailable' }] });
  const result = merge(original, [failed]); const row = result.ledger.rows.find(item => item.slug === 'figma');
  for (const key of ['currentStatus', 'CSSReadback', 'visual', 'promptShown', 'restartAccepted', 'newRuntimeHealthy', 'menuLaunch', 'version', 'build']) assert.equal(row[key], manual[key]);
  assert.equal(row.backgroundVerification.status, 'failed'); assert.equal(result.ledger.counts.passed, 1);
  assert(row.evidence.includes(manual.evidence[0]));
  assert.match(renderTable(result.ledger), /\[full\/manual\]\(live\/figma\/result\.json\)/);
});

test('latest background trial wins, earlier failures and evidence survive a subsequent acceptance', () => {
  const early = background('bruno', 1, { backgroundCSSPassed: false, status: 'background-css-failed', errors: [{ message: 'Old failure' }] });
  const latest = background('bruno', 2, { visualReview: { accepted: true } });
  const first = merge(ledger(), [latest, early]); const row = first.ledger.rows.find(item => item.slug === 'bruno');
  assert.equal(row.backgroundVerification.evidence, latest.evidence);
  assert.equal(row.backgroundTrialHistory.length, 2); assert(row.errors.includes('Old failure'));
  assert.deepEqual(row.backgroundVerification.errors, []);
  const repeated = merge(first.ledger, [early]);
  assert.equal(repeated.ledger.rows.find(item => item.slug === 'bruno').backgroundVerification.evidence, latest.evidence);
});

test('preflight and cancelled background trials remain incomplete without signature failure inventions', () => {
  const preflight = background('bruno', 1, { backgroundCSSPassed: false, before: undefined, processIdentity: undefined,
    checks: { signatureUnchanged: false }, errors: [{ message: 'Preflight failed' }], cleanup: {}, steps: [] });
  preflight.brokerReports = [];
  const result = merge(ledger(), [preflight]); const detail = result.ledger.rows.find(item => item.slug === 'bruno').backgroundVerification;
  assert.equal(detail.status, 'incomplete'); assert.equal(detail.checks.signatureUnchanged, 'pending');
  const cancelled = merge(ledger(), [background('bruno', 1, { backgroundCSSPassed: false, interruption: { signal: 'SIGINT' } })]);
  assert.equal(cancelled.ledger.rows.find(item => item.slug === 'bruno').backgroundVerification.status, 'incomplete');
});

test('rejected images and inconsistent acceptance flags cannot become partial-verified', () => {
  const rejected = merge(ledger(), [background('bruno', 1, { visualReview: { accepted: false, note: 'No visible change.' } })]);
  assert.equal(rejected.ledger.rows.find(item => item.slug === 'bruno').backgroundVerification.status, 'failed');
  const inconsistent = background('bruno', 1, { cleanup: {}, visualReview: { accepted: true } });
  assert.equal(merge(ledger(), [inconsistent]).ledger.rows.find(item => item.slug === 'bruno').backgroundVerification.status, 'incomplete');
});

test('background reports cannot enter native pass merge or spoof a different installed identity', () => {
  const report = background(); const value = ledger();
  const native = mergeLedger(value, { canonicalSlugs: slugs, attempts: [report] });
  assert.equal(native.ledger.counts.passed, 0); assert.equal(native.warnings.length, 1);
  report.report.profile.bundleIdentifier = 'example.other';
  const result = merge(value, [report]); assert.equal(result.ledger.backgroundCounts.attemptedApps, 0);
  assert.equal(result.warnings.length, 1);
});

test('rendered table has canonical 50 rows and labels background proof separately', () => {
  const result = merge(ledger(), [background()]); const table = renderTable(result.ledger);
  assert.deepEqual(result.ledger.rows.map(row => row.slug), slugs);
  assert.equal(table.split('\n').filter(line => line.startsWith('| ')).length, 51);
  assert.match(table, /Background CSS \/ signing/); assert.match(table, /add \*\*zero\*\* full E2E passes/);
});

function manualProofs() {
  const value = ledger(), figma = value.rows.find(row => row.slug === 'figma'), claude = value.rows.find(row => row.slug === 'claude');
  Object.assign(figma, { currentStatus: 'pass', newRuntimeHealthy: 'pending', newConnectedKernelStart: null,
    normalRelaunchSimulation: 'pending', promptShown: 'pass', restartAccepted: 'pass', newConnectedPID: 123 });
  Object.assign(claude, { currentStatus: 'blocked', errors: ['Old build still needs validation; old PID remains.'],
    inventory: { version: 'old-version', build: 'old-build' } });
  const integrity = { valid: true, cdhash: 'a'.repeat(40), sha256: 'b'.repeat(64), files: 10 };
  const identity = { pid: 123, executable: figma.executable, started: '1788896412.298011' };
  const evidence = {
    figma: {
      result: { slug: 'figma', status: 'pass', version: figma.version, normalPID: 122, newConnectedPID: 123,
        checks: { actualRestartPrompt: true, actualRestartAccepted: true, newProcessHealthyAndGreen: true } },
      snapshot: { slug: 'figma', passed: true, app: { bundlePath: figma.bundlePath, bundleIdentifier: figma.bundleIdentifier },
        after: { runtime: { healthy: true, phase: 'active', pid: 123, brokerPid: 124 }, running: [{ pid: 123, kernelStartEpoch: identity.started }] } },
      broker: { slug: 'figma', bundle: figma.bundlePath, appKey: figma.bundleIdentifier, brokerPid: 124,
        processIdentity: identity, finishedAt: '2026-09-08T19:43:06Z', errors: [], before: integrity, during: integrity, after: integrity,
        cleanup: { controllerDisconnected: true, launchedAppLeftRunning: false } }
    },
    claude: {
      result: { slug: 'claude', manualCssPass: true, visualReviewAccepted: true, testedVersion: claude.version },
      preflight: { version: claude.version, profile: { bundleIdentifier: claude.bundleIdentifier }, before: integrity },
      trial: { version: claude.version, slug: 'claude', bundle: claude.bundlePath, verdict: 'pass', cssPass: true,
        errors: [], stylesheetRemoved: true, controllerDisconnected: true, process: { ...identity, executable: claude.executable },
        before: integrity, active: integrity, after: integrity },
      close: { installedVersionAfter: claude.version, ownedPIDAbsent: true, inspectorListenerClosed: true, forceAttempted: false,
        quit: { normalQuit: true, identity: { ...identity, executable: claude.executable } }, after: integrity }
    }
  };
  return { value, evidence };
}

test('fixed manual restart metadata requires a matching healthy kernel lifetime and terminal unchanged session', () => {
  const { value, evidence } = manualProofs();
  const result = mergeVerifiedManualMetadata(value, evidence), row = result.rows.find(row => row.slug === 'figma');
  assert.equal(row.newConnectedKernelStart, '1788896412.298011');
  assert.equal(row.newRuntimeHealthy, 'pass'); assert.equal(row.normalRelaunchSimulation, 'pass');
  assert.equal(value.rows[0].newConnectedKernelStart, null, 'input ledger remains untouched');
  for (const change of [x => { x.snapshot.after.running[0].kernelStartEpoch = '1788896413.000001'; },
    x => { x.broker.errors.push('Disconnect failed'); }, x => { x.broker.cleanup.launchedAppLeftRunning = true; },
    x => { x.snapshot.after.runtime.healthy = false; }, x => { x.broker.during = { ...x.broker.during, sha256: 'different' }; }]) {
    const corrupted = structuredClone(evidence); change(corrupted.figma);
    assert.equal(mergeVerifiedManualMetadata(value, corrupted).rows[0].newConnectedKernelStart, null);
  }
  value.rows[0].currentStatus = 'pending';
  assert.equal(mergeVerifiedManualMetadata(value, evidence).rows[0].currentStatus, 'pending', 'metadata never promotes an unaccepted manual row');
});

test('current Claude manual metadata supersedes stale display prose without inventing build or full E2E proof', () => {
  const { value, evidence } = manualProofs();
  const updated = mergeVerifiedManualMetadata(value, evidence), row = updated.rows.find(row => row.slug === 'claude');
  assert.equal(row.build, null); assert.match(row.buildEvidence, /not recorded/);
  assert.deepEqual(row.inventory, value.rows.find(row => row.slug === 'claude').inventory);
  assert.deepEqual(row.errors, ['Old build still needs validation; old PID remains.']);
  assert.equal(row.currentStatus, 'blocked'); assert.equal(row.CSSReadback, 'pending');
  assert.match(row.reason, /renderer visual proof/);
  const merged = merge(updated, []);
  const rendered = renderTable(merged.ledger).split('\n').find(line => line.startsWith('| claude '));
  assert.match(rendered, /supported Developer menu action/); assert.doesNotMatch(rendered, /Old build still needs/);
  evidence.claude.close.quit.identity.started = '1788896413.000001';
  assert.equal(mergeVerifiedManualMetadata(value, evidence).rows.find(row => row.slug === 'claude').build, 'current-build');
});

test('manual PID presence alone does not render restart as passed while health is pending', () => {
  const { value } = manualProofs();
  const table = renderTable(merge(value, []).ledger);
  const cells = table.split('\n').find(line => line.startsWith('| figma ')).split('|').map(x => x.trim());
  assert.equal(cells[5], 'Pending');
});

function nativeTrial() {
  const attempt = background('bruno', 1, { automatedFlowPassed: true, visualReview: { accepted: true } });
  const report = attempt.report;
  delete report.backgroundCSSPassed;
  report.status = 'awaiting-visual-review';
  report.checks = Object.fromEntries(['initialLaunch', 'CSSReadback', 'disableRestore', 'reenable', 'promptShown',
    'restartAccepted', 'restartRestored', 'menuLaunch', 'menuActivation', 'signatureUnchanged'].map(key => [key, true]));
  report.cleanup = { recordRemoved: true, dockRestored: true, sessionsVerified: true, evidenceCopied: true };
  report.initialPID = report.processIdentity.pid; report.newConnectedPID = 1235;
  const replacement = { ...report.processIdentity, pid: 1235, started: ((Date.parse(report.startedAt) + 10000) / 1000).toFixed(6) };
  report.cleanup.normalQuit = { normalQuit: true, identity: replacement };
  report.quitManaged = { normalQuit: true, identity: report.processIdentity };
  attempt.brokerReports.push(...terminalCopies({ slug: 'bruno', bundlePath: report.profile.bundlePath, bundleIdentifier: report.profile.bundleIdentifier },
    replacement, new Date(Date.parse(report.startedAt) + 9000).toISOString(), report.finishedAt));
  attempt.evidence = attempt.evidence.replace('background-trial-', 'trial-');
  return attempt;
}

test('automated full acceptance requires both terminal sessions, even when summary flags say pass', () => {
  const mergeNative = attempt => mergeLedger(ledger(), { canonicalSlugs: slugs, attempts: [attempt] }).ledger.rows.find(row => row.slug === 'bruno');
  assert.equal(mergeNative(nativeTrial()).currentStatus, 'pass');
  const repeated = nativeTrial(); repeated.brokerReports.push(...structuredClone(repeated.brokerReports.slice(0, 2)));
  assert.equal(mergeNative(repeated).currentStatus, 'pass', 'identical initial/final archive copies are one session');
  for (const change of [
    x => { x.brokerReports = []; },
    x => { x.brokerReports.pop(); },
    x => { x.brokerReports[0].errors.push('Broker cleanup failed'); },
    x => { x.brokerReports[3].phase = 'active'; },
    x => { x.brokerReports[2].cleanup.launchedAppLeftRunning = true; },
    x => { x.brokerReports[2].during = undefined; },
    x => { x.brokerReports[2].after = { ...savedIntegrity, sha256: 'c'.repeat(64) }; },
    x => { x.brokerReports[3].processIdentity = { ...x.brokerReports[3].processIdentity, started: '1788890000.000001' }; },
    x => { x.report.steps[0].passed = false; },
    x => { x.report.cleanup.evidenceCopied = false; },
  ]) {
    const attempt = nativeTrial(); change(attempt);
    const row = mergeNative(attempt);
    assert.notEqual(row.currentStatus, 'pass', change.toString());
    assert.equal(row.latestNativeTrial.automatedFlowPassed, false);
  }
});

test('background acceptance rejects absent, stale or contradictory copied broker evidence', () => {
  for (const change of [
    x => { x.brokerReports = []; },
    x => { x.brokerReports.pop(); },
    x => { x.brokerReports[0].errors.push('Unresolved removal'); },
    x => { x.brokerReports[1].error = 'Stopped with failure'; },
    x => { x.brokerReports[0].finishedAt = null; },
    x => { x.brokerReports[0].startedAt = '2026-09-08T19:00:00Z'; },
    x => { x.brokerReports[0].cleanup.stylesheetRemovalUnresolved = true; },
    x => { x.brokerReports[0].before = { valid: true }; },
    x => { x.brokerReports[0].during = { ...savedIntegrity, files: 11 }; },
    x => { x.brokerReports.push({ ...x.brokerReports[0], finishedAt: '2026-09-08T20:01:29Z' }); },
  ]) {
    const trial = background('bruno', 1, { visualReview: { accepted: true } }); change(trial);
    const row = merge(ledger(), [trial]).ledger.rows.find(row => row.slug === 'bruno');
    assert.equal(row.backgroundVerification.status, 'incomplete', change.toString());
    assert.equal(row.backgroundVerification.backgroundCSSPassed, false);
    assert.equal(row.currentStatus, 'pending');
  }
});

const returnedPin = () => ({ observedAt: '2026-09-08T20:01:40Z', ownedPinReturned: true,
  evidence: 'output/e2e-50/2026-09-08/user-state-checkpoint.json' });

test('returned owned Dock pin invalidates cleanup while retaining independently verified CSS and images', () => {
  const trial = background('bruno', 1, { visualReview: { accepted: true }, postTrialDockObservation: returnedPin() });
  const result = merge(ledger(), [trial]), detail = result.ledger.rows.find(row => row.slug === 'bruno').backgroundVerification;
  assert.equal(detail.status, 'failed'); assert.equal(detail.backgroundCSSPassed, false);
  assert.equal(detail.checks.cleanup, 'fail'); assert.equal(detail.postTrialDockCleanupRegression, true);
  for (const key of ['CSSReadback', 'disableRestore', 'reenable', 'signatureUnchanged']) assert.equal(detail.checks[key], 'pass');
  assert.equal(detail.visual, 'pass'); assert.equal(detail.cssVisualVerified, true);
  assert.equal(result.ledger.backgroundCounts.partialVerified, 0);
  assert.equal(result.ledger.backgroundCounts.cssVisualVerified, 1);
  assert.equal(result.ledger.backgroundCounts.postTrialCleanupRegressions, 1);
  assert.equal(result.ledger.counts.passed, 0);
  assert.deepEqual(detail.postTrialDockObservation, trial.report.postTrialDockObservation);
  assert.match(renderTable(result.ledger), /retain verified CSS\/image evidence/);
});

test('later scoped Dock recovery does not rewrite failed automatic cleanup, but a fresh trial can pass', () => {
  const old = background('bruno', 1, { visualReview: { accepted: true }, postTrialDockObservation: {
    ...returnedPin(), recovery: { completedAt: '2026-09-08T20:01:50Z', scopedRestoreSucceeded: true,
      evidence: 'output/e2e-50/2026-09-08/returned-pin-cleanup.json' }
  } });
  const first = merge(ledger(), [old]);
  assert.equal(first.ledger.rows.find(row => row.slug === 'bruno').backgroundVerification.status, 'failed');
  const fresh = background('bruno', 2, { visualReview: { accepted: true } });
  const next = merge(first.ledger, [fresh, old]);
  const row = next.ledger.rows.find(row => row.slug === 'bruno');
  assert.equal(row.backgroundVerification.status, 'partial-verified');
  assert.equal(row.backgroundTrialHistory[0].postTrialDockCleanupRegression, true);
  assert.equal(row.backgroundTrialHistory[0].postTrialDockObservation.recovery.scopedRestoreSucceeded, true);
  assert.equal(next.ledger.backgroundCounts.partialVerified, 1);
  assert.equal(next.ledger.backgroundCounts.postTrialCleanupRegressions, 0);
});

test('post-trial observation cannot weaken full cleanup or silently accept malformed metadata', () => {
  const full = nativeTrial(); full.report.postTrialDockObservation = returnedPin();
  const updated = mergeLedger(ledger(), { canonicalSlugs: slugs, attempts: [full] });
  const row = updated.ledger.rows.find(row => row.slug === 'bruno');
  assert.equal(row.currentStatus, 'fail'); assert.equal(row.cleanup, 'fail');
  assert.equal(row.CSSReadback, 'pass'); assert.equal(row.visual, 'pass');
  for (const observation of [null, {}, { ...returnedPin(), ownedPinReturned: false, observedAt: '2026-09-08T19:00:00Z' },
    { ...returnedPin(), ownedPinReturned: false, evidence: '/tmp/unrelated.json' }]) {
    const trial = background('bruno', 1, { visualReview: { accepted: true }, postTrialDockObservation: observation });
    const result = merge(ledger(), [trial]).ledger.rows.find(row => row.slug === 'bruno').backgroundVerification;
    assert.equal(result.status, 'incomplete'); assert.equal(result.checks.cleanup, 'pending');
  }
  const checked = background('bruno', 1, { visualReview: { accepted: true },
    postTrialDockObservation: { ...returnedPin(), ownedPinReturned: false } });
  assert.equal(merge(ledger(), [checked]).ledger.rows.find(row => row.slug === 'bruno').backgroundVerification.status, 'partial-verified');
});

test('a different-GUID alias pin withholds cleanup acceptance without attributing ownership to the trial', () => {
  const observation = { observedAt: '2026-09-08T20:01:40Z', conflictingPinObserved: true,
    currentGUID: 2474016623, receiptGUID: 876299418, automaticCleanupVerified: false,
    evidence: 'output/e2e-50/2026-09-08/user-state-checkpoint.json' };
  const trial = background('bruno', 1, { visualReview: { accepted: true }, postTrialDockObservation: observation });
  const result = merge(ledger(), [trial]), detail = result.ledger.rows.find(row => row.slug === 'bruno').backgroundVerification;
  assert.equal(detail.status, 'failed'); assert.equal(detail.checks.cleanup, 'pending');
  assert.equal(detail.cssVisualVerified, true); assert.equal(detail.checks.CSSReadback, 'pass');
  assert.equal(detail.postTrialDockCleanupRegression, false);
  assert.equal(detail.postTrialDockCleanupConflict, true);
  assert.equal(detail.postTrialDockObservationValid, true);
  assert.match(detail.reason, /not attributed to this trial/);
  assert.equal(result.ledger.backgroundCounts.partialVerified, 0);
  assert.equal(result.ledger.backgroundCounts.cssVisualVerified, 1);
  assert.equal(result.ledger.backgroundCounts.postTrialCleanupRegressions, 0);
  assert.equal(result.ledger.backgroundCounts.postTrialCleanupConflicts, 1);
  observation.recovery = { scopedRestoreSucceeded: true, completedAt: '2026-09-08T20:01:50Z' };
  assert.equal(merge(ledger(), [trial]).ledger.rows.find(row => row.slug === 'bruno').backgroundVerification.status, 'failed');
});
