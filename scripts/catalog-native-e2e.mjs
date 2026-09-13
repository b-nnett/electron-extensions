// One fixed app at a time; normal quit only. Every action and failure is saved.
import path from 'node:path';
import { mkdir, writeFile, cp, lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { profileFor, harness, registration, normalOpen, normalQuit, readSession, waitSession, captureWholeApp, requireUnlockedDesktop } from './lib/catalog-e2e.mjs';
import { launchFromMenu, acceptRestartPrompt, saveEvents, requirePNG } from './lib/catalog-e2e-ui.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../lib/process-identity.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';
import { readBoundedJSON } from '../lib/catalog-stylesheet.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fileURLToPath(new URL('../', import.meta.url));
const iso = () => new Date().toISOString();

export async function freshEvidenceDirectory(requested, base = path.join(root, 'output/e2e-50')) {
  const output = path.resolve(requested);
  base = await realpath(base);
  if (!output.startsWith(base + path.sep) || output.split(path.sep).some(part => part.toLowerCase().endsWith('.app'))) throw new Error('Save a new canonical run under output/e2e-50.');
  let current = base;
  for (const part of path.relative(base, path.dirname(output)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (await realpath(current) !== current || !(await lstat(current)).isDirectory()) throw new Error('Evidence parents must be canonical directories.');
  }
  await mkdir(output); // Exclusive: even a previously empty run cannot be reused.
  return output;
}

export function isTrackedIdentity(live, identities) {
  return identities.some(saved => sameProcessIdentity(saved, live));
}

export function assertCurrentGreen(session, recordID) {
  const { status, report } = session;
  const revision = report.revisions?.[status.revision - 1];
  if (status.phase !== 'active' || !Number.isInteger(status.revision) || status.revision !== report.revisions?.length ||
      status.computed?.['background-color'] !== 'rgb(22, 163, 74)' || status.computed?.color !== 'rgb(255, 255, 255)' ||
      status.signatureUnchanged !== true || !status.enabledExtensionIDs?.includes(recordID) ||
      !revision?.enabledExtensionIDs?.includes(recordID) || revision.stylesheetReadbackVerified !== true ||
      revision.appliedComputed?.['background-color'] !== 'rgb(22, 163, 74)' || revision.appliedComputed?.color !== 'rgb(255, 255, 255)' ||
      revision.signatureUnchanged !== true) throw new Error('The current revision does not prove this trial’s extension is green with readback and unchanged signing.');
}

export function assertSessionOwnership(session, profile, attempt, broker, nodePath) {
  const { status, report } = session;
  const identity = report.processIdentity;
  if (!attempt || !Number.isFinite(attempt.since) || session.sessionDirectory === attempt.exclude ||
      status.slug !== profile.slug || report.slug !== profile.slug || status.appKey !== profile.bundleIdentifier || report.appKey !== profile.bundleIdentifier ||
      status.bundle !== profile.bundlePath || report.bundle !== profile.bundlePath || report.profile?.executable !== profile.executable ||
      !sameProcessIdentity(identity, status.processIdentity) || identity.executable !== profile.executable || identity.uid !== process.getuid() ||
      !Number.isFinite(Date.parse(report.startedAt)) || Date.parse(report.startedAt) < attempt.since ||
      !sameProcessIdentity(broker, broker) || broker.pid !== report.brokerPid || broker.pid !== status.brokerPid ||
      broker.executable !== nodePath || broker.uid !== process.getuid() || Number(broker.started) * 1000 < attempt.since ||
      Number(identity.started) * 1000 < Number(broker.started) * 1000) throw new Error('Session ownership is not established for this invocation.');
  return identity;
}

export function assertTerminalEvidence(session, owned, profile, before) {
  const { status, report } = session;
  if (status.phase !== 'stopped' || status.error || !Array.isArray(report.errors) || report.errors.length ||
      !Number.isFinite(Date.parse(report.finishedAt)) || Date.parse(report.finishedAt) < Date.parse(report.startedAt) ||
      report.startedAt !== owned.startedAt || report.brokerPid !== owned.broker.pid || status.brokerPid !== owned.broker.pid ||
      report.slug !== profile.slug || report.appKey !== profile.bundleIdentifier || report.bundle !== profile.bundlePath ||
      status.slug !== profile.slug || status.appKey !== profile.bundleIdentifier || status.bundle !== profile.bundlePath ||
      !sameProcessIdentity(report.processIdentity, owned.identity) || !sameProcessIdentity(status.processIdentity, owned.identity) ||
      report.unchanged !== true || report.cleanup?.controllerDisconnected !== true || report.cleanup.targetTerminationRequested !== false ||
      !(report.cleanup.stylesheetRemoved === true || report.cleanup.stylesheetEndedWithApp === true) ||
      report.cleanup.launchedAppLeftRunning !== false || report.cleanup.stylesheetRemovalUnresolved ||
      report.cleanup.launchOutcomeUnknown || report.cleanup.appMayRemainRunning) throw new Error('Session lacks successful terminal cleanup and identity evidence.');
  compareIntegrity(before, report.before);
  compareIntegrity(report.before, report.after);
}

export function flowPassed(report) {
  return report.errors.length === 0 && report.steps.every(step => step.passed === true) &&
    ['initialLaunch', 'CSSReadback', 'disableRestore', 'reenable', 'promptShown', 'restartAccepted', 'restartRestored', 'menuLaunch', 'menuActivation', 'signatureUnchanged'].every(key => report.checks[key] === true) &&
    report.cleanup.recordRemoved === true && report.cleanup.dockRestored === true && report.cleanup.sessionsVerified === true &&
    report.cleanup.evidenceCopied === true && !report.cleanup.appLeftRunning &&
    !Object.entries(report.cleanup).some(([key, value]) => /error/i.test(key) && value);
}

export async function readExactSession(directory, launcherDirectory) {
  if (path.dirname(directory) !== path.join(launcherDirectory, 'Sessions') || !/^[0-9a-f-]{36}$/i.test(path.basename(directory)) ||
      await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('Owned session directory changed.');
  const read = async (name, limit) => {
    const file = path.join(directory, name);
    if (await realpath(file) !== file || !(await lstat(file)).isFile()) throw new Error('Owned session evidence is not a canonical regular file.');
    return readBoundedJSON(file, limit);
  };
  return { sessionDirectory: directory, status: await read('status.json', 64 * 1024), report: await read('report.json', 16 * 1024 * 1024) };
}

export async function waitTerminal(directory, launcherDirectory) {
  const deadline = Date.now() + 45000;
  do {
    const session = await readExactSession(directory, launcherDirectory);
    if (['stopped', 'error'].includes(session.status.phase) && session.report.finishedAt) return session;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('Owned broker did not publish a terminal report within 45 seconds.');
}

export async function verifySessionPNGs(session) {
  for (const revision of session.report.revisions ?? []) {
    if (!(revision.cssBytes > 0)) continue;
    const names = [revision.screenshots?.before, revision.screenshots?.styled];
    if (revision.restoration) names.push(revision.restoration.screenshot);
    for (const name of names) {
      if (typeof name !== 'string' || path.basename(name) !== name || !name.endsWith('.png')) throw new Error('Session lacks a required contained screenshot.');
      await requirePNG(path.join(session.sessionDirectory, name));
    }
  }
}

export async function runNativeE2E(slug, requestedOutput) {
  const profile = await profileFor(slug);
  if (!profile.runtimeSupported || slug === 'chatgpt' || slug === 'stylelab') throw new Error('Use the separate supervised flow for manual or pre-existing control profiles.');
  const output = await freshEvidenceDirectory(requestedOutput);
  const report = { slug, app: profile.name, startedAt: iso(), profile,
    scope: 'Native menu launch, stored fixed green CSS, disable/enable, normal original-app relaunch, actual prompt acceptance, connected replacement, and cleanup.',
    actualUpdaterInstallTested: false, steps: [], checks: {}, errors: [], cleanup: {}, visualReview: 'pending' };
  let recordID, launcherDirectory, currentIdentity, initialSession, restoredSession, initialRegistry;
  const sessions = new Map(), identities = [];
  let pendingAttempt;
  const save = () => writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const step = async (name, action) => {
    process.stdout.write(`${iso()} ${slug}: ${name}\n`);
    const item = { name, startedAt: iso() }; report.steps.push(item); await save();
    try { const result = await action(); item.finishedAt = iso(); item.passed = true; await save(); return result; }
    catch (error) { item.finishedAt = iso(); item.passed = false; item.error = error.message; if (error.result) item.details = error.result; throw error; }
  };
  const action = (name, number) => harness(name, slug, path.join(output, `${number}-${name}.json`), name === 'add' ? undefined : recordID);
  const claimSession = async session => {
    const config = await readBoundedJSON(path.join(launcherDirectory, 'configuration.json'), 64 * 1024);
    if (config.profile !== profile.slug || config.targetBundlePath !== profile.bundlePath || config.targetBundleIdentifier !== profile.bundleIdentifier ||
        config.brokerPath !== path.join(launcherDirectory, `${profile.name} Launcher.app`, 'Contents/Resources/Runtime/scripts/dock-catalog-session.mjs')) throw new Error('Launcher configuration does not match this fixed trial.');
    const broker = await getProcessIdentity(session.report.brokerPid);
    const identity = assertSessionOwnership(session, profile, pendingAttempt, broker, await realpath(config.nodePath));
    const live = await getProcessIdentity(identity.pid);
    if (!sameProcessIdentity(identity, live)) throw new Error('Claimed session process has already exited or changed.');
    identities.push(identity);
    sessions.set(session.sessionDirectory, { identity, broker, startedAt: session.report.startedAt });
    pendingAttempt = undefined;
    return identity;
  };
  try {
    await step('verify unlocked desktop before live actions', requireUnlockedDesktop);
    initialRegistry = await registration(profile); report.initialRunning = initialRegistry;
    if (initialRegistry.length) throw new Error('This app was already running before the isolated trial; leave it for a supervised existing-app flow.');
    report.before = await step('strict signature and full bundle fingerprint before', () => inspectIntegrity(profile.bundlePath));
    const added = await step('import temporary extension through native manager', () => action('add', '01'));
    recordID = added.recordID; launcherDirectory = added.after.launcherDirectory;
    report.recordID = recordID; report.launcherDirectory = launcherDirectory;
    profile.name = added.app.name; report.app = profile.name;
    let priorSession; try { priorSession = (await readSession(launcherDirectory)).sessionDirectory; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(2500); // Let the production menu observe the imported library.
    pendingAttempt = { since: Date.now(), exclude: priorSession };
    await step('launch through actual menu item', () => launchFromMenu(profile, path.join(output, 'initial-menu')));
    report.checks.menuLaunch = true;
    initialSession = await step('verify initial connected runtime', () => waitSession(launcherDirectory, 'active', { profile, excludeSessionDirectory: priorSession }));
    currentIdentity = await claimSession(initialSession);
    assertCurrentGreen(initialSession, recordID); report.checks.initialLaunch = true; report.checks.CSSReadback = true; report.initialPID = currentIdentity.pid;
    const connected = await step('native healthy snapshot', () => action('inspect', '02'));
    if (!connected.after.runtime?.healthy || connected.after.runtime.pid !== currentIdentity.pid) throw new Error('Native manager does not consider the current process healthy.');
    await step('capture whole app with extension', () => captureWholeApp(currentIdentity.pid, path.join(output, 'whole-app-enabled.png')));
    await step('disable extension through native manager', () => action('disable', '03'));
    const disabled = await step('verify original control restoration', () => waitSession(launcherDirectory, 'disabled', { profile, newPID: currentIdentity.pid }));
    if (disabled.sessionDirectory !== initialSession.sessionDirectory || !disabled.report.revisions.slice(-2, -1).some(revision => revision.enabledExtensionIDs?.includes(recordID) && revision.restoration?.reason === 'disabled' && revision.restoration.baselineMatches === true)) throw new Error('Disable did not restore the control baseline.');
    report.checks.disableRestore = true;
    await step('capture whole app with extension disabled', () => captureWholeApp(currentIdentity.pid, path.join(output, 'whole-app-disabled.png')));
    await step('enable extension again', () => action('enable', '04'));
    const enabled = await step('verify re-enabled runtime', () => waitSession(launcherDirectory, 'active', { profile, newPID: currentIdentity.pid }));
    if (enabled.sessionDirectory !== initialSession.sessionDirectory) throw new Error('Re-enable changed the owned session.');
    assertCurrentGreen(enabled, recordID); report.checks.reenable = true;
    report.quitManaged = await step('normal quit of managed process', () => normalQuit(profile, currentIdentity));
    currentIdentity = null;
    const initialTerminal = await waitTerminal(initialSession.sessionDirectory, launcherDirectory);
    assertTerminalEvidence(initialTerminal, sessions.get(initialSession.sessionDirectory), profile, report.before);
    await verifySessionPNGs(initialTerminal);
    await cp(initialSession.sessionDirectory, path.join(output, 'session-initial'), { recursive: true, force: false, errorOnExist: true });
    const normalStarted = Date.now();
    report.normalOpen = await step('open original app without launch flags', () => normalOpen(profile));
    let normal;
    for (let i = 0; i < 80; i++) {
      const rows = await registration(profile);
      if (rows.length === 1) { normal = await getProcessIdentity(rows[0].pid); if (normal) break; }
      if (rows.length > 1) throw new Error('Ordinary launch produced multiple registered instances.');
      await delay(250);
    }
    if (!sameProcessIdentity(normal, normal) || normal.executable !== profile.executable || normal.uid !== process.getuid() || Number(normal.started) * 1000 < normalStarted) throw new Error('Ordinary launch did not register the expected fresh live app.');
    identities.push(normal);
    currentIdentity = normal; report.normalPID = normal.pid; report.normalIdentity = normal;
    await delay(2000);
    await step('capture whole app after ordinary relaunch', () => captureWholeApp(normal.pid, path.join(output, 'whole-app-normal-relaunch.png')));
    pendingAttempt = { since: Date.now(), exclude: initialSession.sessionDirectory };
    report.prompt = await step('wait for and accept actual app-specific restart alert', () => acceptRestartPrompt(profile, normal.pid, path.join(output, 'restart'), { since: normalStarted }));
    pendingAttempt.since = Date.parse(report.prompt.clickedAt);
    report.checks.promptShown = true; report.checks.restartAccepted = true;
    restoredSession = await step('verify a new connected process after restart', () => waitSession(launcherDirectory, 'active', { profile, excludePID: normal.pid, excludeSessionDirectory: initialSession.sessionDirectory }));
    currentIdentity = await claimSession(restoredSession);
    assertCurrentGreen(restoredSession, recordID); report.newConnectedPID = currentIdentity.pid;
    const restarted = await step('native healthy snapshot after restart', () => action('inspect', '05'));
    if (!restarted.after.runtime?.healthy || restarted.after.runtime.pid !== currentIdentity.pid) throw new Error('Native manager does not consider restarted app healthy.');
    report.checks.restartRestored = true;
    await step('capture whole app after restart', () => captureWholeApp(currentIdentity.pid, path.join(output, 'whole-app-after-restart.png')));
    await step('activate running app through actual menu item', () => launchFromMenu(profile, path.join(output, 'restored-menu')));
    await delay(800);
    const rows = await registration(profile);
    if (rows.length !== 1 || rows[0].pid !== currentIdentity.pid || !sameProcessIdentity(currentIdentity, await getProcessIdentity(rows[0].pid))) throw new Error('Menu activation unexpectedly replaced the connected app.');
    report.checks.menuActivation = true;
  } catch (error) {
    if (!recordID && error.result?.recordID) { recordID = error.result.recordID; launcherDirectory = error.result.after?.launcherDirectory; }
    report.errors.push({ at: iso(), message: error.message, ...(error.result ? { details: error.result } : {}) });
  } finally {
    // A failed renderer startup can still have launched an app. Adopt it only
    // from this pending invocation's new, fixed-profile session and live broker.
    if (pendingAttempt && launcherDirectory) {
      try { await claimSession(await readSession(launcherDirectory)); }
      catch (error) { report.cleanup.unclaimedSessionError = error.message; }
    }
    if (recordID) {
      try { await step('remove only the temporary extension and restore Dock', () => action('remove', '90')); report.cleanup.recordRemoved = true; report.cleanup.dockRestored = true; }
      catch (error) { report.errors.push({ at: iso(), message: `Cleanup: ${error.message}`, details: error.result }); }
    }
    if (launcherDirectory) {
      try {
        const session = await readSession(launcherDirectory);
        if (sessions.has(session.sessionDirectory) && ['active', 'applying', 'disabled'].includes(session.status.phase) && recordID) {
          const disabled = await waitSession(launcherDirectory, 'disabled', { profile, newPID: session.report.processIdentity.pid, timeoutMs: 15000 });
          if (disabled.sessionDirectory !== session.sessionDirectory || !disabled.report.revisions.slice(-2, -1).some(revision => revision.enabledExtensionIDs?.includes(recordID) && revision.restoration?.reason === 'disabled' && revision.restoration.baselineMatches === true)) throw new Error('Removal did not verify restoration in the owned session.');
        }
      } catch (error) { report.cleanup.removalVerificationError = error.message; }
    }
    if (initialRegistry?.length === 0) {
      try {
        const rows = await registration(profile);
        if (rows.length === 1) {
          const live = await getProcessIdentity(rows[0].pid);
          if (isTrackedIdentity(live, identities)) report.cleanup.normalQuit = await normalQuit(profile, live);
          else report.cleanup.appLeftRunning = true;
        } else if (rows.length > 1) report.cleanup.appLeftRunning = true;
        else report.cleanup.appAlreadyExited = true;
      } catch (error) { report.cleanup.quitError = error.message; }
    }
    report.cleanup.sessionsVerified = sessions.size === 2;
    report.cleanup.evidenceCopied = sessions.size === 2;
    let index = 0;
    for (const [directory, owned] of sessions) {
      try {
        const terminal = await waitTerminal(directory, launcherDirectory);
        assertTerminalEvidence(terminal, owned, profile, report.before);
        await verifySessionPNGs(terminal);
        const deadline = Date.now() + 3000;
        let broker;
        do { broker = await getProcessIdentity(owned.broker.pid); if (!sameProcessIdentity(owned.broker, broker)) break; await delay(100); } while (Date.now() < deadline);
        if (sameProcessIdentity(owned.broker, broker)) throw new Error('Terminal broker process is still running.');
      } catch (error) { report.cleanup.sessionsVerified = false; report.errors.push({ at: iso(), message: `Terminal evidence: ${error.message}`, sessionDirectory: directory }); }
      try {
        await readExactSession(directory, launcherDirectory);
        await cp(directory, path.join(output, `session-final-${++index}`), { recursive: true, errorOnExist: true, force: false });
      } catch (error) { report.cleanup.evidenceCopied = false; report.errors.push({ at: iso(), message: `Evidence copy: ${error.message}`, sessionDirectory: directory }); }
    }
    try {
      report.after = await inspectIntegrity(profile.bundlePath);
      report.checks.signatureUnchanged = report.before ? compareIntegrity(report.before, report.after).unchanged : false;
    } catch (error) { report.errors.push({ at: iso(), message: `Final integrity: ${error.message}` }); }
    try { report.events = await saveEvents(profile, path.join(output, 'native-events.json'), Date.parse(report.startedAt)); }
    catch (error) { report.errors.push({ at: iso(), message: `Native event evidence: ${error.message}` }); }
    report.finishedAt = iso();
    report.automatedFlowPassed = flowPassed(report);
    report.status = report.automatedFlowPassed ? 'awaiting-visual-review' : 'failed';
    await save();
  }
  process.stdout.write(`${iso()} ${slug}: ${report.status}; ${report.errors.map(error => error.message).join(' | ')}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [slug, output] = process.argv.slice(2);
  if (!slug || !output) throw new Error('Usage: catalog-native-e2e.mjs <fixed slug> <new evidence directory>');
  const result = await runNativeE2E(slug, output);
  if (!result.automatedFlowPassed) process.exitCode = 1;
}
