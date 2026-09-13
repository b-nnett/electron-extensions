// Read-only by default. This records supervised results; it never runs an app.
import { readFile, readdir, realpath, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sameProcessIdentity } from '../lib/process-identity.mjs';
import { compareIntegrity } from '../lib/integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = path.join(root, 'output/e2e-50/2026-09-08');
const ledgerPath = path.join(base, 'results.json');
const tablePath = path.join(base, 'results-table.md');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const epoch = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const pid = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const relative = value => path.relative(root, value);
const unique = values => [...new Set(values)];
const requiredChecks = ['initialLaunch', 'CSSReadback', 'disableRestore', 'reenable', 'promptShown',
  'restartAccepted', 'restartRestored', 'menuLaunch', 'menuActivation', 'signatureUnchanged'];
const stages = {
  nativeInitialLaunch: ['initialLaunch', ['verify initial connected runtime']],
  CSSReadback: ['CSSReadback', ['verify initial connected runtime']],
  disableRestore: ['disableRestore', ['verify original control restoration']],
  promptShown: ['promptShown', ['wait for and accept actual app-specific restart alert']],
  restartAccepted: ['restartAccepted', ['wait for and accept actual app-specific restart alert']],
  newRuntimeHealthy: ['restartRestored', ['verify a new connected process after restart', 'native healthy snapshot after restart']],
  menuLaunch: ['menuLaunch', ['launch through actual menu item']],
  menuActivation: ['menuActivation', ['activate running app through actual menu item']],
  reenable: ['reenable', ['verify re-enabled runtime']]
};

function messages(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim().slice(0, 8000)] : [];
  if (Array.isArray(value)) return value.flatMap(messages);
  if (!object(value)) return [];
  return ['message', 'error', 'errors', 'quitError', 'removalVerificationError', 'sessionReadError', 'evidenceCopyError']
    .flatMap(key => messages(value[key]));
}

function detailReports(report, extras) {
  const details = [...(report.steps ?? []).map(step => step.details), ...(report.errors ?? []).map(error => error?.details)];
  return [...extras, ...details.flatMap(detail => object(detail) ? [detail, detail.report, detail.status].filter(object) : [])];
}

function validNative(attempt, row) {
  const report = attempt.report;
  return object(report) && report.slug === row.slug && object(report.profile) && report.profile.runtimeSupported === true &&
    report.profile.slug === row.slug && report.profile.bundlePath === row.bundlePath &&
    report.profile.bundleIdentifier === row.bundleIdentifier && report.profile.executable === row.executable &&
    Array.isArray(report.steps) && object(report.checks) && Array.isArray(report.errors) && object(report.cleanup) &&
    !Object.hasOwn(report, 'backgroundCSSPassed') && !String(report.status ?? '').startsWith('background-css-') &&
    typeof report.automatedFlowPassed === 'boolean' && epoch(report.startedAt) !== null && epoch(report.finishedAt) !== null &&
    epoch(report.finishedAt) >= epoch(report.startedAt);
}

function validBackground(attempt, row) {
  const report = attempt.report;
  return object(report) && report.slug === row.slug && object(report.profile) && report.profile.runtimeSupported === true &&
    report.profile.slug === row.slug && report.profile.bundlePath === row.bundlePath &&
    report.profile.bundleIdentifier === row.bundleIdentifier && report.profile.executable === row.executable &&
    Array.isArray(report.steps) && object(report.checks) && Array.isArray(report.errors) && object(report.cleanup) &&
    report.automatedFlowPassed === false && typeof report.backgroundCSSPassed === 'boolean' &&
    epoch(report.startedAt) !== null && epoch(report.finishedAt) !== null && epoch(report.finishedAt) >= epoch(report.startedAt);
}

function terminalEvidenceErrors(attempt, background = false) {
  const outer = attempt.report, profile = outer.profile;
  // The full runner keeps an identical initial terminal copy both when it
  // restarts and during final archival. Conflicting copies remain distinct.
  const copies = [...new Map((attempt.brokerReports ?? []).filter(object).map(item => [JSON.stringify(item), item])).values()];
  const sameSavedIntegrity = (a, b) => {
    for (const item of [a, b]) if (item?.valid !== true || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') ||
      !/^[a-f0-9]{40}$/.test(item.cdhash ?? '') || !Number.isInteger(item.files) || item.files <= 0) throw new Error('Incomplete integrity evidence.');
    if (a.files !== b.files) throw new Error('File inventory changed.');
    compareIntegrity(a, b);
  };
  const expected = background ? [outer.processIdentity?.pid] : [outer.initialPID, outer.newConnectedPID];
  if (expected.some(value => !pid(value)) || new Set(expected).size !== expected.length) return ['Required managed process identities are missing or duplicated.'];
  const reports = copies.filter(item => object(item) && Array.isArray(item.revisions));
  if (reports.length !== expected.length) return ['Required terminal broker report copies are missing or duplicated.'];
  const issues = [];
  try { sameSavedIntegrity(outer.before, outer.after); } catch { issues.push('Outer before/after integrity evidence differs or is incomplete.'); }
  for (const targetPID of expected) {
    const matches = reports.filter(item => item.processIdentity?.pid === targetPID);
    if (matches.length !== 1) { issues.push('A required managed PID lacks exactly one terminal broker report.'); continue; }
    const report = matches[0], identity = report.processIdentity;
    const statuses = copies.filter(item => object(item) && typeof item.phase === 'string' && item.brokerPid === report.brokerPid);
    const status = statuses[0], cleanup = report.cleanup;
    const known = [outer.processIdentity, outer.quitManaged?.identity, outer.cleanup?.normalQuit?.identity].filter(item => item?.pid === targetPID);
    if (statuses.length !== 1 || status.phase !== 'stopped' || status.pid !== null || status.error ||
        !sameProcessIdentity(identity, status.processIdentity) || known.some(item => !sameProcessIdentity(identity, item)) ||
        identity.executable !== profile.executable || !Number.isInteger(identity.uid) || identity.uid < 0 ||
        report.slug !== profile.slug || report.bundle !== profile.bundlePath || report.appKey !== profile.bundleIdentifier ||
        status.slug !== profile.slug || status.bundle !== profile.bundlePath || status.appKey !== profile.bundleIdentifier ||
        !pid(report.brokerPid) || status.startedAt !== report.startedAt ||
        epoch(report.startedAt) === null || epoch(report.finishedAt) === null ||
        epoch(report.startedAt) < epoch(outer.startedAt) || epoch(report.finishedAt) < epoch(report.startedAt) ||
        epoch(report.finishedAt) > epoch(outer.finishedAt) || epoch(status.updatedAt) < epoch(report.finishedAt) ||
        Number(identity.started) * 1000 < epoch(report.startedAt) ||
        !Array.isArray(report.errors) || report.errors.length || report.unchanged !== true ||
        cleanup?.controllerDisconnected !== true || cleanup.targetTerminationRequested !== false ||
        !(cleanup.stylesheetRemoved === true || cleanup.stylesheetEndedWithApp === true) ||
        cleanup.launchedAppLeftRunning !== false || cleanup.stylesheetRemovalUnresolved ||
        cleanup.launchOutcomeUnknown || cleanup.appMayRemainRunning) {
      issues.push('A copied broker session lacks matching successful terminal ownership/cleanup evidence.');
    }
    try {
      sameSavedIntegrity(outer.before, report.before); sameSavedIntegrity(report.before, report.during); sameSavedIntegrity(report.before, report.after);
    } catch { issues.push('A copied broker session lacks unchanged before/during/after bundle evidence.'); }
  }
  return unique(issues);
}

function postTrialDockEvidence(report) {
  if (!Object.hasOwn(report, 'postTrialDockObservation')) return { observation: null, valid: null, regression: false, conflict: false, errors: [] };
  const observation = report.postTrialDockObservation;
  const conflict = observation?.conflictingPinObserved === true;
  const guid = value => Number.isInteger(value) && value > 0 && value <= 4294967295;
  const valid = object(observation) && (typeof observation.ownedPinReturned === 'boolean' || conflict) &&
    (!conflict || (observation.automaticCleanupVerified === false && guid(observation.currentGUID) &&
      guid(observation.receiptGUID) && observation.currentGUID !== observation.receiptGUID)) &&
    epoch(observation.observedAt) !== null && epoch(observation.observedAt) >= epoch(report.finishedAt) &&
    typeof observation.evidence === 'string' && observation.evidence.startsWith('output/e2e-50/2026-09-08/') &&
    path.normalize(observation.evidence) === observation.evidence && !/[\0\r\n]/.test(observation.evidence);
  const regression = observation?.ownedPinReturned === true;
  // Recovery may fix today's Dock state; it cannot turn the original automated
  // cleanup into a success. Only a fresh trial can establish that new outcome.
  const errors = conflict ? ['A pin for the generated alias has a GUID different from the current receipt; automatic Dock cleanup is unverified. The conflicting pin is not attributed to this trial.'] :
    regression ? ['The owned Dock pin returned after the trial; original automated cleanup is invalidated. Later scoped recovery does not erase this regression.'] :
    observation?.automaticCleanupVerified === false ? ['The post-trial observation could not verify automatic Dock cleanup.'] :
    !valid ? ['Post-trial Dock observation is incomplete or invalid; automatic cleanup acceptance is withheld.'] : [];
  return { observation, valid, regression, conflict, errors };
}

function summarizeAttempt(attempt) {
  const report = attempt.report;
  const details = detailReports(report, attempt.brokerReports ?? []);
  const identities = [report.processIdentity, report.normalIdentity, report.cleanup?.normalQuit?.identity,
    ...details.map(item => item.processIdentity), ...details.map(item => item.status?.processIdentity)].filter(object);
  const launchConfirmed = [report.initialPID, report.normalPID, report.newConnectedPID, ...identities.map(item => item.pid)].some(pid) ||
    report.checks.initialLaunch === true || details.some(item => pid(item.pid) || pid(item.launch?.pid));
  const launchRequested = launchConfirmed || report.checks.menuLaunch === true || details.some(item => item.launchRequested === true);
  const brokerErrors = unique(details.flatMap(item => [...messages(item.errors), ...messages(item.error)]));
  const errors = unique([...messages(report.errors), ...messages(report.cleanup), ...brokerErrors]);
  const failedSteps = report.steps.filter(step => step.passed === false).map(step => step.name);
  const terminalErrors = terminalEvidenceErrors(attempt, Object.hasOwn(report, 'backgroundCSSPassed'));
  const postTrialDock = postTrialDockEvidence(report);
  const fullAutomatedFlow = report.automatedFlowPassed === true && requiredChecks.every(key => report.checks[key] === true) &&
    report.cleanup.recordRemoved === true && report.cleanup.dockRestored === true && !report.cleanup.quitError &&
    report.cleanup.sessionsVerified === true && report.cleanup.evidenceCopied === true &&
    report.cleanup.appLeftRunning !== true && errors.length === 0 && terminalErrors.length === 0 && postTrialDock.errors.length === 0 && report.steps.every(step => step.passed === true);
  const visualAccepted = object(report.visualReview) && report.visualReview.accepted === true;
  const visualRejected = object(report.visualReview) && report.visualReview.accepted === false;
  let status;
  if (fullAutomatedFlow && visualAccepted) status = 'pass';
  else if (fullAutomatedFlow && !visualRejected) status = 'in-progress';
  else if (postTrialDock.regression || postTrialDock.conflict) status = 'fail';
  else if (!launchConfirmed) status = 'incomplete';
  else if (report.automatedFlowPassed === true && !fullAutomatedFlow) status = 'incomplete';
  else status = 'fail';
  const reason = fullAutomatedFlow && !visualAccepted && !visualRejected ? 'Automated flow passed; agent visual inspection is pending.' :
    fullAutomatedFlow && visualRejected ? messages(report.visualReview.note)[0] ?? 'Visual review did not accept this trial.' :
    status === 'pass' ? 'Automated flow and agent visual inspection accepted.' :
    postTrialDock.errors[0] ?? brokerErrors[0] ?? errors[0] ?? terminalErrors[0] ?? (report.automatedFlowPassed && !fullAutomatedFlow ?
      'Automated acceptance flag lacks complete stage/cleanup evidence.' : 'Trial did not complete all required checks.');
  return { evidence: attempt.evidence, startedAt: report.startedAt, finishedAt: report.finishedAt,
    reportedStatus: report.status ?? null, currentStatus: status, automatedFlowPassed: fullAutomatedFlow,
    visualReview: report.visualReview ?? 'pending', launchConfirmed, launchRequested,
    failureScope: status === 'incomplete' && !launchConfirmed ? 'preflight-or-unconfirmed-launch; not an app compatibility failure' :
      status === 'fail' ? 'current native flow; not a universal app incompatibility claim' : null,
    failedSteps, brokerErrors, errors, terminalErrors,
    postTrialDockObservation: postTrialDock.observation, postTrialDockObservationValid: postTrialDock.valid,
    postTrialDockCleanupRegression: postTrialDock.regression, postTrialDockCleanupConflict: postTrialDock.conflict,
    postTrialCleanupErrors: postTrialDock.errors, reason, identities };
}

function stageValue(report, summary, key, names) {
  if (report.checks[key] === true) return 'pass';
  if (!summary.launchConfirmed) return 'pending';
  if (report.checks[key] === false || summary.failedSteps.some(name => names.includes(name))) return 'fail';
  return 'pending';
}

function summarizeBackground(attempt) {
  const report = attempt.report;
  const common = summarizeAttempt(attempt);
  const required = ['nativeOpen', 'currentCSS', 'nativeHealthy', 'disableRestore', 'reenable', 'signatureUnchanged'];
  const cleanup = ['recordRemoved', 'dockRestored', 'removalRestored', 'sessionVerified', 'evidenceCopied'];
  const originalBackgroundFlowPassed = report.backgroundCSSPassed === true && !report.interruption && common.errors.length === 0 && common.terminalErrors.length === 0 &&
    report.steps.every(step => step.passed === true) && required.every(key => report.checks[key] === true) &&
    cleanup.every(key => report.cleanup[key] === true) && report.cleanup.appLeftRunning !== true &&
    object(report.before) && object(report.after);
  const backgroundCSSPassed = originalBackgroundFlowPassed && common.postTrialCleanupErrors.length === 0;
  const visualAccepted = object(report.visualReview) && report.visualReview.accepted === true;
  const visualRejected = object(report.visualReview) && report.visualReview.accepted === false;
  const status = backgroundCSSPassed ? visualAccepted ? 'partial-verified' : visualRejected ? 'failed' : 'partial-awaiting-visual-review' :
    common.postTrialDockCleanupRegression || common.postTrialDockCleanupConflict ? 'failed' :
    !common.launchConfirmed || report.interruption || report.backgroundCSSPassed === true ? 'incomplete' : 'failed';
  const reason = backgroundCSSPassed && visualAccepted ? 'Background CSS and renderer-image review accepted; full UI/menu/prompt/restart E2E remains untested by this run.' :
    backgroundCSSPassed && !visualRejected ? 'Background CSS checks passed; renderer-image review and full UI/menu/prompt/restart E2E remain pending.' :
    visualRejected ? messages(report.visualReview.note)[0] ?? 'Background renderer-image review was not accepted.' :
    report.interruption ? 'Background trial was cancelled; retained checks do not establish a completed flow.' :
    common.postTrialCleanupErrors[0] ?? common.brokerErrors[0] ?? common.errors[0] ?? common.terminalErrors[0] ?? 'Background checks or cleanup did not complete.';
  const broker = (attempt.brokerReports ?? []).find(item => item.bundle === report.profile.bundlePath && typeof item.version === 'string');
  const imageScopes = (broker?.revisions ?? []).filter(revision => object(revision.screenshots))
    .map(revision => revision.screenshotScope);
  const fullRendererImages = imageScopes.length > 0 && imageScopes.every(scope =>
    typeof scope === 'string' && scope.startsWith('Complete visible renderer;'));
  const backgroundImageScope = fullRendererImages
    ? 'Full renderer images; native window chrome is not included.'
    : 'Saved renderer images; earlier trials may contain control crops. No native whole-window proof.';
  const checks = {
    nativeOpen: stageValue(report, common, 'nativeOpen', ['open through production manager']),
    CSSReadback: stageValue(report, common, 'currentCSS', ['verify connected current CSS revision']),
    nativeHealthy: stageValue(report, common, 'nativeHealthy', ['inspect native healthy session']),
    disableRestore: stageValue(report, common, 'disableRestore', ['verify disable restoration']),
    reenable: stageValue(report, common, 'reenable', ['verify current re-enabled CSS']),
    signatureUnchanged: object(report.before) && object(report.after) && typeof report.checks.signatureUnchanged === 'boolean'
      ? report.checks.signatureUnchanged ? 'pass' : 'fail' : 'pending',
    cleanup: common.postTrialDockCleanupRegression ? 'fail' : common.postTrialCleanupErrors.length ? 'pending' :
      cleanup.every(key => report.cleanup[key] === true) && report.cleanup.appLeftRunning !== true ? 'pass' :
      report.cleanup.appLeftRunning === true || messages(report.cleanup).length ? 'fail' : 'pending'
  };
  return { evidence: attempt.evidence, startedAt: report.startedAt, finishedAt: report.finishedAt,
    reportedStatus: report.status ?? null, status, scope: 'native-manager-background-css-only',
    countsTowardFullE2E: false, automatedFlowPassed: false, backgroundCSSPassed,
    cssVisualVerified: originalBackgroundFlowPassed && visualAccepted,
    testedVersion: broker?.version ?? report.version ?? null, testedBuild: broker?.build ?? report.build ?? null,
    transport: report.profile.transport, selector: report.profile.target?.selector ?? null,
    checks, visual: visualAccepted ? 'pass' : visualRejected ? 'fail' : 'pending', visualReview: report.visualReview ?? 'pending',
    backgroundImageScope, visualScope: backgroundImageScope,
    fullAppVisual: 'pending', menuLaunch: 'pending', promptShown: 'pending', restartAccepted: 'pending', restart: 'pending',
    actualUpdaterInstallTested: false, launchConfirmed: common.launchConfirmed, launchRequested: common.launchRequested,
    processIdentity: report.processIdentity ?? null, failedSteps: common.failedSteps,
    failureScope: status === 'incomplete' && !common.launchConfirmed ? 'preflight-or-unconfirmed-launch; not an app compatibility failure' :
      status === 'failed' ? 'background CSS trial only; no full E2E conclusion' : null,
    errors: common.errors, brokerErrors: common.brokerErrors, terminalErrors: common.terminalErrors,
    postTrialDockObservation: common.postTrialDockObservation, postTrialDockObservationValid: common.postTrialDockObservationValid,
    postTrialDockCleanupRegression: common.postTrialDockCleanupRegression, postTrialDockCleanupConflict: common.postTrialDockCleanupConflict,
    postTrialCleanupErrors: common.postTrialCleanupErrors, reason };
}

/** Pure merge for synthetic validation. Attempts contain saved reports, never actions. */
export function mergeLedger(ledger, { canonicalSlugs, attempts = [], backgroundAttempts = [], manualFinishedAt = {}, now = new Date().toISOString() }) {
  if (!Array.isArray(canonicalSlugs) || canonicalSlugs.length !== 50 || new Set(canonicalSlugs).size !== 50 ||
      !Array.isArray(ledger.rows) || ledger.rows.length !== 50 || new Set(ledger.rows.map(row => row.slug)).size !== 50 ||
      ledger.rows.some(row => !canonicalSlugs.includes(row.slug))) throw new Error('Ledger must contain exactly the canonical catalog 49 plus ChatGPT.');
  const updated = structuredClone(ledger);
  const updatedRows = [], updatedBackgroundRows = [], warnings = [];
  updated.rows = canonicalSlugs.map(slug => {
    const row = updated.rows.find(item => item.slug === slug);
    const possible = attempts.filter(attempt => attempt.report?.slug === slug);
    const eligible = possible.filter(attempt => validNative(attempt, row)).sort((a, b) =>
      epoch(a.report.finishedAt) - epoch(b.report.finishedAt) || a.evidence.localeCompare(b.evidence));
    for (const attempt of possible.filter(item => !eligible.includes(item))) warnings.push(`Ignored incomplete/invalid native result: ${attempt.evidence}`);
    if (!eligible.length) return row;
    const latest = eligible.at(-1);
    const priorEvidence = row.latestNativeTrial?.evidence;
    const manualTime = epoch(manualFinishedAt[slug]);
    const previousTime = epoch(row.latestNativeTrial?.finishedAt);
    const cutoff = Math.max(manualTime ?? -Infinity, previousTime ?? -Infinity);
    if (latest.evidence !== priorEvidence && epoch(latest.report.finishedAt) <= cutoff) return row;
    if (row.currentStatus !== 'pending' && !priorEvidence && manualTime === null) {
      warnings.push(`Preserved manual ${slug} row: no dated baseline proves this native trial is newer.`);
      return row;
    }
    const report = latest.report;
    const summary = summarizeAttempt(latest);
    for (const [field, [key, names]] of Object.entries(stages)) row[field] = stageValue(report, summary, key, names);
    row.visual = object(report.visualReview) && typeof report.visualReview.accepted === 'boolean'
      ? report.visualReview.accepted ? 'pass' : 'fail' : 'pending';
    row.signatureUnchanged = object(report.before) && object(report.after) && typeof report.checks.signatureUnchanged === 'boolean'
      ? report.checks.signatureUnchanged ? 'pass' : 'fail' : 'pending';
    row.cleanup = summary.postTrialDockCleanupRegression ? 'fail' : summary.postTrialCleanupErrors.length ? 'pending' :
      report.cleanup.recordRemoved === true && report.cleanup.dockRestored === true &&
      !report.cleanup.quitError && report.cleanup.appLeftRunning !== true &&
      (report.cleanup.normalQuit?.normalQuit === true || report.cleanup.appAlreadyExited === true) ? 'pass' :
      report.cleanup.quitError || report.cleanup.removalVerificationError || report.cleanup.appLeftRunning === true ? 'fail' : 'pending';
    row.normalRelaunchSimulation = pid(report.normalPID) && object(report.normalIdentity) ? 'pass' : 'pending';
    row.actualUpdaterInstallTested = false;
    row.previousPID = pid(report.normalPID) ? report.normalPID : null;
    row.newConnectedPID = pid(report.newConnectedPID) ? report.newConnectedPID : null;
    const newIdentity = summary.identities.find(item => item.pid === row.newConnectedPID);
    row.newConnectedKernelStart = typeof newIdentity?.started === 'string' ? newIdentity.started : null;
    row.currentStatus = summary.currentStatus;
    row.latestNativeTrial = { ...summary };
    delete row.latestNativeTrial.identities;
    const history = new Map((row.trialHistory ?? []).map(item => [item.evidence, item]));
    for (const attempt of eligible) {
      const item = summarizeAttempt(attempt); delete item.identities; history.set(attempt.evidence, item);
    }
    row.trialHistory = [...history.values()].sort((a, b) => (epoch(a.finishedAt) ?? 0) - (epoch(b.finishedAt) ?? 0));
    row.evidence = unique([...(row.evidence ?? []), ...eligible.map(attempt => attempt.evidence)]);
    row.errors = unique([...messages(row.errors), ...row.trialHistory.flatMap(item => item.errors ?? [])]);
    row.errorsScope = 'Preserved attempt history; latestNativeTrial.errors and reason describe the current result.';
    row.specialSetup = unique([...(row.specialSetup ?? []), ...messages(report.specialWork), ...messages(report.specialSetup)]);
    row.transport = report.profile.transport;
    if (report.profile.target?.selector) row.selector = report.profile.target.selector;
    const broker = (latest.brokerReports ?? []).find(item => item.bundle === row.bundlePath && typeof item.version === 'string');
    // A saved trial establishes its tested version, not the app currently on
    // disk after a later update. Preserve the independent installed inventory.
    row.latestNativeTrial.testedVersion = broker?.version ?? report.version ?? null;
    row.latestNativeTrial.testedBuild = broker?.build ?? report.build ?? null;
    updatedRows.push(slug);
    return row;
  });
  // Background results never rewrite full E2E stage flags, status, manual
  // evidence interpretation, or the independently maintained installed version.
  for (const row of updated.rows) {
    const possible = backgroundAttempts.filter(attempt => attempt.report?.slug === row.slug);
    const eligible = possible.filter(attempt => validBackground(attempt, row)).sort((a, b) =>
      epoch(a.report.finishedAt) - epoch(b.report.finishedAt) || a.evidence.localeCompare(b.evidence));
    for (const attempt of possible.filter(item => !eligible.includes(item))) warnings.push(`Ignored incomplete/invalid background result: ${attempt.evidence}`);
    if (!eligible.length) continue;
    const history = new Map((row.backgroundTrialHistory ?? []).map(item => [item.evidence, item]));
    for (const attempt of eligible) history.set(attempt.evidence, summarizeBackground(attempt));
    row.backgroundTrialHistory = [...history.values()].sort((a, b) => epoch(a.finishedAt) - epoch(b.finishedAt) || a.evidence.localeCompare(b.evidence));
    const latest = row.backgroundTrialHistory.at(-1);
    row.backgroundVerification = { ...latest };
    row.evidence = unique([...(row.evidence ?? []), ...eligible.map(attempt => attempt.evidence)]);
    row.errors = unique([...messages(row.errors), ...row.backgroundTrialHistory.flatMap(item => item.errors ?? [])]);
    row.errorsScope = 'Preserved full/manual and background attempt history. latestNativeTrial and backgroundVerification describe their separate current results.';
    updatedBackgroundRows.push(row.slug);
  }
  const count = status => updated.rows.filter(row => row.currentStatus === status).length;
  updated.counts = { total: 50, pending: count('pending'), inProgress: count('in-progress'), passed: count('pass'),
    failed: count('fail'), blocked: count('blocked'), incomplete: count('incomplete') };
  if (Object.values(updated.counts).slice(1).reduce((a, b) => a + b, 0) !== 50) throw new Error('Unknown ledger status would lose a canonical row.');
  const backgroundCount = status => updated.rows.filter(row => row.backgroundVerification?.status === status).length;
  updated.backgroundCounts = { attemptedApps: updated.rows.filter(row => row.backgroundVerification).length,
    partialVerified: backgroundCount('partial-verified'), awaitingVisualReview: backgroundCount('partial-awaiting-visual-review'),
    failed: backgroundCount('failed'), incomplete: backgroundCount('incomplete'),
    cssVisualVerified: updated.rows.filter(row => row.backgroundVerification?.cssVisualVerified === true).length,
    postTrialCleanupRegressions: updated.rows.filter(row => row.backgroundVerification?.postTrialDockCleanupRegression === true).length,
    postTrialCleanupConflicts: updated.rows.filter(row => row.backgroundVerification?.postTrialDockCleanupConflict === true).length,
    countsTowardFullE2E: false };
  updated.updatedAt = now;
  updated.phase = 'supervised-native-e2e-in-progress';
  return { ledger: updated, updatedRows, updatedBackgroundRows, warnings };
}

const cell = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function concise(value) {
  const text = String(value ?? '');
  const execution = text.split('\n').find(line => line.includes('execution error:'));
  return cell((execution ?? text).replace(/\s+/g, ' ').slice(0, 220));
}
const symbol = value => ({ pass: 'Pass', fail: 'Fail', pending: 'Pending', blocked: 'Blocked', 'not-applicable': 'N/A' }[value] ?? 'Pending');
const evidenceLink = (file, label = 'result') => `[${label}](${encodeURI(path.relative(base, path.resolve(root, file))).replace(/\(/g, '%28').replace(/\)/g, '%29')})`;

/** Fill omitted metadata from the two fixed manual proofs, never promote a row. */
export function mergeVerifiedManualMetadata(ledger, { figma, claude } = {}) {
  const updated = structuredClone(ledger);
  const sameIntegrity = (a, b) => a?.valid === true && b?.valid === true && typeof a.sha256 === 'string' &&
    ['sha256', 'cdhash', 'files'].every(key => a[key] === b[key]);
  const row = updated.rows.find(item => item.slug === 'figma');
  if (figma && row?.currentStatus === 'pass' && !row.latestNativeTrial) {
    const { result, snapshot, broker } = figma;
    const runtime = snapshot?.after?.runtime, identity = broker?.processIdentity;
    const running = snapshot?.after?.running;
    if (result?.slug === row.slug && result.status === 'pass' && result.version === row.version &&
        snapshot?.slug === row.slug && snapshot.passed === true && snapshot.app?.bundlePath === row.bundlePath &&
        snapshot.app?.bundleIdentifier === row.bundleIdentifier && runtime?.healthy === true && runtime.phase === 'active' &&
        runtime.pid === result.newConnectedPID && pid(result.normalPID) && result.normalPID !== runtime.pid &&
        identity?.pid === runtime.pid && identity.executable === row.executable && /^[1-9]\d*\.\d{6}$/.test(identity.started ?? '') &&
        Array.isArray(running) && running.length === 1 && running[0].pid === identity.pid && running[0].kernelStartEpoch === identity.started &&
        broker.slug === row.slug && broker.bundle === row.bundlePath && broker.appKey === row.bundleIdentifier &&
        broker.brokerPid === runtime.brokerPid && epoch(broker.finishedAt) !== null && broker.errors?.length === 0 &&
        sameIntegrity(broker.before, broker.during) && sameIntegrity(broker.before, broker.after) &&
        broker.cleanup?.controllerDisconnected === true && broker.cleanup.launchedAppLeftRunning === false &&
        result.checks?.actualRestartPrompt === true && result.checks.actualRestartAccepted === true && result.checks.newProcessHealthyAndGreen === true) {
      row.previousPID = result.normalPID; row.newConnectedPID = identity.pid;
      row.newConnectedKernelStart = identity.started; row.newRuntimeHealthy = 'pass'; row.normalRelaunchSimulation = 'pass';
      row.manualMetadataEvidence = ['output/e2e-50/2026-09-08/live/figma/result.json',
        'output/e2e-50/2026-09-08/live/figma/06-fixed-restart-inspect.json',
        'output/e2e-50/2026-09-08/live/figma/session-fixed-final/report.json'];
    }
  }
  const manual = updated.rows.find(item => item.slug === 'claude');
  if (claude && manual?.currentStatus === 'blocked' && !manual.latestNativeTrial) {
    const { result, trial, preflight, close } = claude;
    if (result?.slug === manual.slug && result.manualCssPass === true && result.visualReviewAccepted === true &&
        result.testedVersion === manual.version && preflight?.version === manual.version && trial?.version === manual.version &&
        close?.installedVersionAfter === manual.version && trial.slug === manual.slug && trial.bundle === manual.bundlePath &&
        preflight.profile?.bundleIdentifier === manual.bundleIdentifier && trial.verdict === 'pass' && trial.cssPass === true &&
        trial.errors?.length === 0 && trial.stylesheetRemoved === true && trial.controllerDisconnected === true &&
        close.ownedPIDAbsent === true && close.inspectorListenerClosed === true && close.quit?.normalQuit === true &&
        trial.process?.pid === close.quit.identity?.pid && trial.process?.started === close.quit.identity?.started &&
        trial.process?.executable === manual.executable && close.forceAttempted === false &&
        sameIntegrity(preflight.before, trial.before) && sameIntegrity(trial.before, trial.active) &&
        sameIntegrity(trial.before, trial.after) && sameIntegrity(trial.before, close.after)) {
      // The fixed verifier records the marketing version, not CFBundleVersion.
      // Do not keep a previous build number beside this newer verified version.
      manual.build = typeof trial.build === 'string' ? trial.build : null;
      manual.buildEvidence = trial.build ? 'Current manual verification report.' : 'CFBundleVersion was not recorded in current manual evidence; the older inventory is preserved separately.';
      manual.reason = `Current ${trial.version} manual CSS/restoration and renderer visual proof passed with unchanged signing and normal quit. A supported Developer menu action is required for each fresh process; automatic native integration is unverified.`;
      manual.manualMetadataEvidence = ['output/e2e-50/2026-09-08/live/claude/manual-supported-1.49585.0/result.json',
        'output/e2e-50/2026-09-08/live/claude/manual-supported-1.49585.0/preflight.json',
        'output/e2e-50/2026-09-08/live/claude/manual-supported-1.49585.0/verification/report.json',
        'output/e2e-50/2026-09-08/live/claude/manual-supported-1.49585.0/close.json'];
      manual.errorsScope = 'Preserved historical attempts; reason and manualVerification describe the latest separate manual proof.';
    }
  }
  return updated;
}

export function renderTable(ledger) {
  const c = ledger.counts;
  const b = ledger.backgroundCounts;
  const lines = ['# Native app E2E — 8 September 2026', '',
    `${c.passed}/50 accepted; ${c.inProgress} awaiting completion/review; ${c.failed} failed flows; ${c.incomplete} incomplete; ${c.blocked} blocked; ${c.pending} pending.`, '',
    ...(b ? [`Separate background checks: ${b.partialVerified} partial CSS/image results accepted; ${b.awaitingVisualReview} awaiting image review; ${b.failed} failed; ${b.incomplete} incomplete. These add **zero** full E2E passes.`, ''] : []),
    ...(b?.postTrialCleanupRegressions || b?.postTrialCleanupConflicts ? [`${b.cssVisualVerified} background results retain verified CSS/image evidence; later Dock observations include ${b.postTrialCleanupRegressions ?? 0} returned owned pins and ${b.postTrialCleanupConflicts ?? 0} ownership conflicts. CSS appearance and automatic cleanup acceptance are separate.`, ''] : []),
    'Inventory/signature validity is separate from runtime proof. A normal original-app relaunch simulates lost launch flags; no updater installation is claimed. Historical CSS passes are not current E2E passes.', '',
    '“Incomplete” includes infrastructure/preflight errors and unconfirmed launches. “Fail” describes this native flow, not universal app incompatibility. Visual acceptance is required after the full automated flow passes. Earlier errors remain in JSON history.', '',
    'Background columns cover native-manager CSS and saved renderer images (earlier trials may contain control crops). They never prove native window chrome, menu, restart alert, or restart recovery. Existing full/manual evidence remains separate.', '',
    '| App | Full CSS | Full visual | Full disable | Restart | Menu | Full signing | Full result / reason | Background CSS / signing | Background visual | Background result / reason | Special work / limits | Evidence |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const row of ledger.rows) {
    const restart = [row.promptShown, row.restartAccepted, row.newRuntimeHealthy];
    const restartValue = restart.includes('fail') ? 'fail' : restart.every(value => value === 'pass') ? 'pass' : 'pending';
    const background = row.backgroundVerification;
    const backgroundErrors = new Set((row.backgroundTrialHistory ?? []).flatMap(item => item.errors ?? []));
    const fullErrors = messages(row.errors).filter(message => !backgroundErrors.has(message));
    const reason = row.latestNativeTrial?.reason ?? row.reason ?? (row.currentStatus === 'pass' ? 'Manually recorded accepted flow.' : fullErrors[0] ?? 'Current full flow not completed.');
    const evidence = row.latestNativeTrial?.evidence ?? row.evidence?.filter(file => !file.includes('/background-trial-')).at(-1);
    const links = [evidence ? evidenceLink(evidence, 'full/manual') : null,
      background?.evidence ? evidenceLink(background.evidence, 'background') : null].filter(Boolean).join(' · ');
    const bgResult = background ? `**${cell(background.status)}** — ${concise(background.reason)}${background.testedVersion ? ` (tested ${cell(background.testedVersion)})` : ''}` : 'Pending';
    lines.push(`| ${cell(row.app)} ${cell(row.version ?? '')} | ${symbol(row.CSSReadback)} | ${symbol(row.visual)} | ${symbol(row.disableRestore)} | ${symbol(restartValue)} | ${symbol(row.menuLaunch)} | ${symbol(row.signatureUnchanged)} | **${cell(row.currentStatus)}** — ${concise(reason)} | ${symbol(background?.checks?.CSSReadback)} / ${symbol(background?.checks?.signatureUnchanged)} | ${symbol(background?.visual)} | ${bgResult} | ${concise((row.specialSetup ?? []).join(' '))} | ${links || '—'} |`);
  }
  lines.push('', 'Full stage flags, retained earlier trials, specific broker errors, cleanup, and evidence paths are in [results.json](results.json).', '');
  return lines.join('\n');
}

async function boundedJSON(file, max = 16 * 1024 * 1024) {
  if (await realpath(file) !== file) throw new Error('Evidence path is not canonical.');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > max) throw new Error('Evidence is not a bounded regular file.');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > max) throw new Error('Evidence grew beyond its bound.');
  return JSON.parse(text);
}

async function brokerCopies(directory) {
  const reports = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || !/^session(?:-[A-Za-z0-9_-]+)?$/.test(item.name)) continue;
    for (const file of ['report.json', 'status.json']) {
      try { reports.push(await boundedJSON(path.join(directory, item.name, file))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return reports;
}

export async function buildUpdate() {
  const original = await readFile(ledgerPath, 'utf8');
  const ledger = JSON.parse(original);
  const cohort = await boundedJSON(path.join(root, 'compatibility/apps.json'));
  const canonicalSlugs = [...cohort.map(row => row.slug), 'chatgpt'];
  const attempts = [], backgroundAttempts = [], warnings = [], manualFinishedAt = {};
  for (const slug of canonicalSlugs) {
    const folder = path.join(base, 'live', slug);
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // Custom/manual results establish freshness only; they are never reinterpreted.
    try {
      const manual = await boundedJSON(path.join(folder, 'result.json'));
      if (manual.slug === slug && epoch(manual.finishedAt) !== null) manualFinishedAt[slug] = manual.finishedAt;
    } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Manual ${slug} evidence unreadable: ${error.message}`); }
    for (const item of entries) {
      if (!item.isDirectory() || !/^(?:background-)?trial-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name)) continue;
      const directory = path.join(folder, item.name), file = path.join(directory, 'result.json');
      try {
        const report = await boundedJSON(file);
        if (epoch(report.finishedAt) === null) continue; // An active writer is not a finished attempt.
        let copies = [];
        try { copies = await brokerCopies(directory); }
        catch (error) { warnings.push(`Broker copies incomplete at ${relative(directory)}: ${error.message}`); }
        (item.name.startsWith('background-') ? backgroundAttempts : attempts).push({ evidence: relative(file), report, brokerReports: copies });
      } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Unreadable trial ${relative(file)}: ${error.message}`); }
    }
  }
  const merged = mergeLedger(ledger, { canonicalSlugs, attempts, backgroundAttempts, manualFinishedAt });
  const manualMetadata = {};
  for (const [slug, files] of Object.entries({
    figma: { result: 'result.json', snapshot: '06-fixed-restart-inspect.json', broker: 'session-fixed-final/report.json' },
    claude: { result: 'manual-supported-1.49585.0/result.json', preflight: 'manual-supported-1.49585.0/preflight.json',
      trial: 'manual-supported-1.49585.0/verification/report.json', close: 'manual-supported-1.49585.0/close.json' }
  })) {
    try {
      manualMetadata[slug] = {};
      for (const [key, file] of Object.entries(files)) manualMetadata[slug][key] = await boundedJSON(path.join(base, 'live', slug, file));
    } catch (error) { delete manualMetadata[slug]; warnings.push(`Manual ${slug} metadata not refreshed: ${error.message}`); }
  }
  merged.ledger = mergeVerifiedManualMetadata(merged.ledger, manualMetadata);
  merged.warnings.unshift(...warnings);
  return { ...merged, original, table: renderTable(merged.ledger) };
}

async function atomicWrite(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--write')) throw new Error('Usage: node scripts/update-e2e-ledger.mjs [--write]');
  const result = await buildUpdate();
  if (args[0] === '--write') {
    if (await readFile(ledgerPath, 'utf8') !== result.original) throw new Error('Ledger changed during collection; rerun to preserve the latest manual edits.');
    await atomicWrite(ledgerPath, JSON.stringify(result.ledger, null, 2) + '\n');
    await atomicWrite(tablePath, result.table);
  }
  process.stdout.write(JSON.stringify({ mode: args[0] === '--write' ? 'written' : 'dry-run; no files changed',
    counts: result.ledger.counts, backgroundCounts: result.ledger.backgroundCounts,
    updatedRows: result.updatedRows, updatedBackgroundRows: result.updatedBackgroundRows, warnings: result.warnings,
    outputs: [relative(ledgerPath), relative(tablePath)] }, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
