// Summarize saved evidence. Does not launch, install, or modify any app.
import { readFile, readdir, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const maybeRead = file => read(file).catch(() => null);
const entries = folder => readdir(path.join(root, folder), { withFileTypes: true }).catch(() => []);
const exists = file => access(path.join(root, file)).then(() => true, () => false);
const catalog = await read('compatibility/apps.json');
if (catalog.length !== 49 || new Set(catalog.map(app => app.slug)).size !== 49) throw new Error('Expected 49 distinct catalog apps.');
const clean = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const link = (label, file) => `[${label}](../${file})`;
const computedPass = r => (r.css?.matchesExpected ?? r.application?.matchesExpected) === true && (r.css?.matchesOriginal ?? r.removal?.matchesOriginal) === true;
const integrityPass = r => (r.activeUnchanged ?? r.during?.unchanged) === true && (r.unchanged ?? r.after?.unchanged) === true;
const visualPass = v => v?.pass === true || v?.visualPass === true || v?.result === 'pass';
const developerMode = r => r?.mode === 'official-developer-mode-main-inspector';
const setupCleaned = (r, file, setup) => Boolean(
  r?.stylesheetRemoved === true && r?.controllerDisconnected === true &&
  setup?.restoration?.debuggerListenerClosed === true &&
  Array.isArray(setup?.cssEvidence) && setup.cssEvidence.includes(file) && Date.parse(setup.restoration.completedAt) >= Date.parse(r.finishedAt) &&
  Number.isInteger(r.process?.pid) && typeof r.process?.started === 'string' && typeof r.process?.executable === 'string' &&
  Array.isArray(setup.processIdentities) && setup.processIdentities.some(identity =>
    r.process.pid === identity.pid && r.process.started === identity.started &&
    r.process.executable === identity.executable && r.process.uid === identity.uid)
);
const lifecycle = r => ({
  exitCode: r?.launch?.exitCode ?? null, signal: r?.launch?.signal ?? null,
  forcedStop: r?.forcedOwnedChildStop ?? r?.forcedKill ?? false,
  processExited: r?.processExited ?? r?.ownedProcessExited ?? r?.ownedProcessStopped ?? null,
  temporaryProfileRemoved: r?.temporaryProfileRemoved ?? null,
  ownedLaunch: r?.scope?.ownedLaunch ?? null,
  existingProfile: r?.scope?.existingProfile ?? null,
  stylesheetRemoved: r?.stylesheetRemoved ?? null,
  controllerDisconnected: r?.controllerDisconnected ?? null
});
const originalControls = { slack: 'Sign in to Slack', vscode: 'Continue with GitHub', notion: 'Continue in Browser',
  signal: 'Need help? link', postman: 'Create Free Account', obsidian: 'Quick start', github: 'Sign in to GitHub.com',
  discord: 'Find or start a conversation', figma: 'Log in with browser' };
const rows = [];

for (const app of catalog) {
  const attempts = [];
  const base = `output/compatibility/${app.slug}`;
  const setupEvidence = app.slug === 'claude' ? `${base}/developer-mode-setup/report.json` : null;
  const setup = setupEvidence ? await maybeRead(setupEvidence) : null;
  const addAttempt = async file => {
    const report = await maybeRead(file);
    if (!report) return;
    const folder = path.dirname(file);
    attempts.push({ file, report, visual: await maybeRead(`${folder}/visual-review.json`),
      screenshotsPresent: (await Promise.all(['before', 'green', 'restored'].map(name => exists(`${folder}/${name}.png`)))).every(Boolean) });
  };
  for (const transport of ['pipe', 'tcp', ...(app.slug === 'claude' ? ['developer-mode'] : [])]) {
    for (const item of await entries(`${base}/${transport}`)) {
      if (!item.isDirectory()) continue;
      await addAttempt(`${base}/${transport}/${item.name}/report.json`);
      await addAttempt(`${base}/${transport}/${item.name}/launchservices-followup.json`);
    }
  }
  await addAttempt(`${base}/report.json`);
  await addAttempt(`${base}/launchservices-followup.json`);
  attempts.sort((a, b) => String(b.report.startedAt ?? '').localeCompare(String(a.report.startedAt ?? '')));
  let verified = null;
  if (app.cohort === 'original-nine') {
    const report = await read(app.cssEvidence);
    const screenshots = await Promise.all(['before', 'green', 'restored'].map(name => exists(`${path.dirname(app.cssEvidence)}/${name}.png`)));
    if (!computedPass(report) || !integrityPass(report) || !screenshots.every(Boolean) || report.errors?.length) throw new Error(`Historical proof incomplete: ${app.slug}`);
    verified = { file: app.cssEvidence, report, historicalVisualReview: true };
  } else {
    for (const attempt of attempts) {
      const r = attempt.report;
      if (r.verdict !== 'pass' || !computedPass(r) || !integrityPass(r) || r.errors?.length) continue;
      if (developerMode(r) && !setupCleaned(r, attempt.file, setup)) continue;
      if (visualPass(attempt.visual) && attempt.screenshotsPresent) { verified = attempt; break; }
    }
  }
  const installs = [];
  for (const item of await entries(`output/installations/${app.slug}`)) {
    if (!item.isFile() || !item.name.endsWith('.json')) continue;
    const file = `output/installations/${app.slug}/${item.name}`;
    const report = await maybeRead(file);
    if (report) installs.push({ file, report });
  }
  installs.sort((a, b) => String(b.report.startedAt ?? '').localeCompare(String(a.report.startedAt ?? '')));
  const installation = installs.find(i => i.report.status === 'installed') ?? installs[0] ?? null;
  const imagePreparation = await maybeRead(`${base}/image-test-preparation.json`);
  const diagnoses = [];
  for (const item of await entries(`${base}/diagnostics`)) {
    if (!item.isDirectory()) continue;
    for (const name of ['diagnosis.json', 'adapter-confirmation.json']) {
      const file = `${base}/diagnostics/${item.name}/${name}`;
      const diagnostic = await maybeRead(file);
      if (diagnostic) diagnoses.push({ file, report: diagnostic });
    }
  }
  diagnoses.sort((a, b) => String(b.report.finishedAt ?? b.report.completedAt ?? b.report.recordedAt ?? '').localeCompare(String(a.report.finishedAt ?? a.report.completedAt ?? a.report.recordedAt ?? '')));
  const diagnosis = diagnoses[0] ?? null;
  const latest = attempts[0] ?? null;
  const observed = attempts.find(a => computedPass(a.report) && integrityPass(a.report));
  const selected = verified ?? observed ?? latest;
  const report = selected?.report;
  const developerModeCleanup = developerMode(report) ? setupCleaned(report, selected.file, setup) : null;
  const cssStatus = verified ? 'Verified' : observed ? 'Observed / incomplete' : latest ? 'Not reached / incomplete' : 'Not tested';
  const visual = latest?.visual;
  const limitations = verified ? [] : [!developerMode(report) && (diagnosis?.report.diagnosis || diagnosis?.report.limitation), imagePreparation?.errors?.join(' '),
    visual?.reason || visual?.limitation || visual?.lifecycleLimitation,
    latest?.report.cosmeticTrial?.reason || latest?.report.limitation || latest?.report.error || latest?.report.errors?.map(e => e.message ?? e).join('; ')
  ].filter(Boolean);
  if (!verified && observed && !visualPass(observed.visual)) limitations.push('Computed CSS application and restoration succeeded; the complete visual/lifecycle acceptance criteria did not.');
  const cleanup = lifecycle(report);
  const launchFollowup = attempts.find(a => a.file.endsWith('/launchservices-followup.json'));
  // A successful visible CSS round trip and a clean full trial are different
  // observations. Rancher has explicit positive visual evidence but an
  // interrupted lifecycle; preserve its incomplete verdict above.
  const visibleRoundTrip = Boolean(verified || (selected?.screenshotsPresent &&
    (visualPass(selected?.visual) || (selected?.visual?.visualApplicationObserved === true && selected?.visual?.visualRestorationObserved === true)) &&
    computedPass(report) && integrityPass(report)));
  if (cleanup.signal && !['SIGTERM', 'SIGKILL'].includes(cleanup.signal)) limitations.push(`Shutdown ended with ${cleanup.signal}; lifecycle reliability remains unverified.`);
  if (cleanup.exitCode !== null && cleanup.exitCode !== 0) limitations.push(`App exited with code ${cleanup.exitCode}.`);
  if (cleanup.forcedStop || cleanup.signal === 'SIGKILL') limitations.push('Owned main process required forced termination.');
  else if (launchFollowup?.report.forcedKill) limitations.push('The LaunchServices follow-up required identity-checked forced termination.');
  if (app.slug === 'slack') limitations.push('Verified against an existing checked loopback session; a fresh launch is not proven.');
  if (app.slug === 'discord') limitations.push('Successful LaunchServices trial used the existing signed-in profile and home-screen control; the Log In button was not tested.');
  if (app.slug === 'wave') limitations.push('Earlier CSS round trip and later read-only previews produced blank crops; a recognizable control remains unverified.');
  if (developerMode(report)) {
    limitations.push('Official Developer Mode required manual setup. Fixed main-process JavaScript performed the cosmetic trial, with fixed read-only renderer appearance checks. General-purpose extension JavaScript is not verified. Each controller trial borrowed an existing app process and profile, removed its stylesheet, and detached rather than terminating the app.');
    limitations.push(developerModeCleanup
      ? 'The debugger listener was closed separately; see setup/cleanup evidence.'
      : 'Separate debugger-listener cleanup is pending or unverified.');
    if (setup?.restoration?.developerModeLeftEnabled === true) limitations.push('The documented Developer Mode remains enabled as persistent setup; full settings rollback is not claimed.');
  }
  const localMetadata = app.electron?.local_evidence ? await maybeRead(app.electron.local_evidence) : null;
  const metadata = installation?.report.source?.metadata ?? imagePreparation?.sourceMetadata ?? localMetadata;
  const testedVersion = report?.version ?? report?.appVersion ?? attempts.find(a => a.report.version)?.report.version ??
    (app.slug === 'figma' ? '126.8.18' : metadata?.version) ?? null;
  if (developerMode(report) && metadata?.version && metadata.version !== testedVersion) limitations.push(`The installed app is now ${metadata.version}; the CSS proof tested ${testedVersion}. The newer installed version has not been CSS-tested.`);
  rows.push({
    slug: app.slug, name: app.name, cohort: app.cohort, bundlePath: app.bundlePath,
    installationStatus: imagePreparation ? 'read-only image; not permanently installed' : installation?.report.status ?? (app.alreadyInstalled || app.cohort === 'original-nine' ? 'previously installed' : 'not attempted'),
    installationEvidence: imagePreparation ? `${base}/image-test-preparation.json` : installation?.file ?? app.electron?.local_evidence ?? null,
    installedVersion: imagePreparation ? null : metadata?.version ?? testedVersion,
    electronVersion: report?.runtime?.electron ?? metadata?.electronVersion ?? metadata?.electron_version ?? app.electron?.declaredVersion ?? null,
    cssStatus, testedVersion,
    transport: developerMode(report) ? 'Official Developer Mode / main-process inspector' : report?.mode?.includes('pipe') ? 'CDP pipe' : report ? 'CDP TCP' : null,
    targetType: report?.target?.type ?? (report ? 'page' : null),
    selector: report?.css?.selector ?? report?.selector ?? null,
    control: selected?.visual?.control ?? report?.control ?? originalControls[app.slug] ?? null,
    cssEvidence: selected?.file ?? null,
    latestAttempt: latest?.file ?? null,
    diagnosticEvidence: developerMode(report) ? setupEvidence : diagnosis?.file ?? null,
    diagnosis: developerMode(report) ? 'Fixed cosmetic CSS application and restoration were observed through official Developer Mode; separate debugger-listener cleanup is required for acceptance.' : diagnosis?.report.diagnosis ?? diagnosis?.report.interpretation ?? diagnosis?.report.limitation ?? null,
    priorDiagnosticEvidence: developerMode(report) ? diagnosis?.file ?? null : null,
    visualEvidence: selected?.visual ? `${path.dirname(selected.file)}/visual-review.json` : verified?.historicalVisualReview ? 'COMPATIBILITY.md' : null,
    computedCssRoundTrip: report ? computedPass(report) : false,
    visibleCssRoundTripObserved: visibleRoundTrip,
    failureStage: verified ? null : visibleRoundTrip ? 'lifecycle' : observed ? 'visual verification' : 'startup / target discovery',
    integrityUnchanged: report ? integrityPass(report) || report.unchanged === true || report.integrity?.unchanged === true : false,
    lifecycle: cleanup,
    executionScope: report?.scope ?? null,
    setupCleanup: developerMode(report) ? { evidence: setupEvidence, required: true, verified: developerModeCleanup,
      developerModeRestored: setup?.restoration?.developerModeRestored ?? null,
      developerModeLeftEnabled: setup?.restoration?.developerModeLeftEnabled ?? null,
      debuggerListenerClosed: setup?.restoration?.debuggerListenerClosed ?? false,
      appExited: setup?.restoration?.appExited ?? null,
      completedAt: setup?.restoration?.completedAt ?? null } : null,
    launchFollowupLifecycle: launchFollowup ? { evidence: launchFollowup.file, ...lifecycle(launchFollowup.report) } : null,
    limitation: [...new Set(limitations)].join(' '),
    attempts: attempts.map(a => ({ evidence: a.file, startedAt: a.report.startedAt ?? null, status: a.report.status,
      verdict: a.report.verdict ?? null, computedCssRoundTrip: computedPass(a.report), visuallyReviewedPass: visualPass(a.visual) })),
    jsStatus: developerMode(report) && verified ? 'Fixed main-process JS and read-only renderer checks verified; extension JS not verified' : 'Extension JavaScript not verified'
  });
}
const summary = { updatedAt: new Date().toISOString(), scope: 49, original: 9, additional: 40,
  additionalPermanentlyInstalled: rows.filter(r => r.cohort === 'additional-forty' && ['installed', 'previously installed'].includes(r.installationStatus)).length,
  cssVerified: rows.filter(row => row.cssStatus === 'Verified').length,
  additionalCssVerified: rows.filter(row => row.cohort === 'additional-forty' && row.cssStatus === 'Verified').length,
  visibleCssRoundTripsObserved: rows.filter(row => row.visibleCssRoundTripObserved).length,
  failureStages: Object.fromEntries(['startup / target discovery', 'visual verification', 'lifecycle'].map(stage =>
    [stage, rows.filter(row => row.failureStage === stage).map(row => row.slug)])),
  productionJsVerified: 0, productionJsScope: 'General-purpose extension JavaScript',
  fixedMainProcessJsVerified: rows.filter(row => row.cssStatus === 'Verified' && row.executionScope?.mainProcessJavaScript === true).length,
  fixedReadOnlyRendererJsVerified: rows.filter(row => row.cssStatus === 'Verified' && row.executionScope?.rendererJavaScript === 'fixed read-only appearance checks').length,
  rows };
await writeFile(path.join(root, 'compatibility/results.json'), JSON.stringify(summary, null, 2) + '\n');
const lines = [
  '# Expansion verification', '', `Updated ${summary.updatedAt}. **${summary.cssVerified}/49 CSS proofs verified**, including ${summary.additionalCssVerified}/40 additional apps.`, '',
  `${summary.additionalPermanentlyInstalled}/40 additional apps are permanently installed (37 new copies and two pre-existing apps). Rancher was tested from its signed read-only disk image because the installer capacity guard prevented a full copy. Its visible CSS round trip passed, but its overall trial remains incomplete.`, '',
  'A verified CSS result requires application and restoration, unchanged signature and bundle fingerprints, saved screenshots, and a visual review. Claude also requires stylesheet removal, controller disconnection, and separate evidence that the debugger listener was closed. Its documented Developer Mode may remain enabled as persistent setup. The original nine retain their previously reviewed evidence. CSS results do not establish lifecycle reliability: AFFiNE passed CSS checks but exited with SIGSEGV during shutdown. Forced termination and other limitations are listed below. Incomplete launches do not prove universal incompatibility. General-purpose production extension JavaScript remains unverified in all 49 apps.', '',
  `Fixed main-process JavaScript and fixed read-only renderer appearance checks are verified in ${summary.fixedMainProcessJsVerified} app through Claude's official Developer Mode. This scope is limited to the cosmetic proof; it does not establish arbitrary extension support. Claude's controller borrows the existing process, removes its stylesheet, and disconnects. App and debugger-listener cleanup are recorded separately; full settings rollback is not claimed.`, '',
  `Failure stages are recorded separately: ${summary.failureStages['startup / target discovery'].length} apps did not reach CSS, ${summary.failureStages['visual verification'].length} achieved computed CSS changes without a recognizable visual proof, and Rancher visibly worked but had an incomplete lifecycle. Including Rancher, ${summary.visibleCssRoundTripsObserved} apps have an observed visible CSS round trip; the stricter accepted-trial count is ${summary.cssVerified}. See [failure analysis and follow-up](FAILURE-FOLLOWUP.md).`, '',
  'See the [nine-app instructions](INJECTION-GUIDE.md), [catalog pipe instructions](PIPE-GUIDE.md), [sourced selection](APP-CATALOG.md), and [machine-readable results](../compatibility/results.json). Injection uses programmatic CDP calls without Computer Use. These are CLI proofs; the controller GUI still targets the owned fixture.', '',
  'Selectors describe the observed version and screen. Revalidate each against a fresh, explicitly selected target. A successful TCP trial does not establish pipe support. The evidence table retains the strongest CSS attempt; the JSON also lists later unsuccessful follow-ups.', '',
  '| App | Installation | CSS | Tested version | Transport | Control | Observed CSS selector | Evidence |', '| --- | --- | --- | --- | --- | --- | --- | --- |'
];
for (const row of rows) {
  const evidence = [row.installationEvidence && link('Install/source', row.installationEvidence), row.cssEvidence && link('Trial', row.cssEvidence), row.visualEvidence && link('Visual', row.visualEvidence), row.setupCleanup && link('Setup/cleanup', row.setupCleanup.evidence), row.diagnosticEvidence && row.diagnosticEvidence !== row.setupCleanup?.evidence && link('Diagnosis', row.diagnosticEvidence)].filter(Boolean).join(' · ');
  lines.push(`| ${clean(row.name)} | ${clean(row.installationStatus)} | ${row.cssStatus} | ${clean(row.testedVersion)} | ${clean(row.transport)} | ${clean(row.control)} | ${row.selector ? '`' + clean(row.selector) + '`' : '—'} | ${evidence} |`);
}
const limited = rows.filter(row => row.limitation);
if (limited.length) {
  lines.push('', '## Observed limitations', '');
  for (const row of limited) lines.push(`- **${clean(row.name)}:** ${clean(row.limitation)}${row.latestAttempt ? ' ' + link('Latest attempt', row.latestAttempt) : ''}`);
}
lines.push('', 'Reports and screenshots under `output/` are local evidence and are gitignored. Preserve that directory with this handoff. Installed app bundles are retained. Rancher’s image was detached and removed; its preparation report records the separate process, temporary-profile, image and runtime-data cleanup. Requested temporary profiles do not guarantee isolation from persistent app data.', '');
await writeFile(path.join(root, 'docs/EXPANSION-VERIFICATION.md'), lines.join('\n'));
console.log(JSON.stringify({ cssVerified: summary.cssVerified, additionalCssVerified: summary.additionalCssVerified,
  additionalPermanentlyInstalled: summary.additionalPermanentlyInstalled, results: 'compatibility/results.json', guide: 'docs/EXPANSION-VERIFICATION.md' }));
