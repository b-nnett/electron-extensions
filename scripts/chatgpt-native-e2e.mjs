// Supervised, fixed ChatGPT profile only. No app actions occur on import.
import path from 'node:path';
import os from 'node:os';
import { cp, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { profileFor, harness, registration, normalOpen, normalQuit, readSession, waitSession, captureWholeApp, requireUnlockedDesktop } from './lib/catalog-e2e.mjs';
import { launchFromMenu, acceptRestartPrompt, requirePNG, saveEvents } from './lib/catalog-e2e-ui.mjs';
import { freshEvidenceDirectory, isTrackedIdentity, readExactSession, waitTerminal } from './catalog-native-e2e.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../lib/process-identity.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';
import { readBoundedJSON } from '../lib/catalog-stylesheet.mjs';

export const ORIGINAL_HIDE_ID = '8C12BB85-B94C-4FDE-8517-16A0470A6FAD';
const ORIGINAL_IDS = [ORIGINAL_HIDE_ID, 'B670E42B-83D6-4C04-82FC-26B45043F03A', '0215A2E4-50D5-4FB3-8645-E7692DB3B9C2'];
const appKey = 'com.openai.codex', slug = 'chatgpt';
const root = fileURLToPath(new URL('../', import.meta.url));
const support = path.join(os.homedir(), 'Library/Application Support/Extensions Anywhere');
const libraryFile = path.join(support, 'library.json');
const iso = () => new Date().toISOString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);

export function validateOriginalRecords(library) {
  if (!Array.isArray(library.records) || library.records.length !== 3 || new Set(library.records.map(record => record.id)).size !== 3 ||
      !ORIGINAL_IDS.every(id => library.records.some(record => record.id === id))) throw new Error('The expected three original records are not uniquely present.');
  const hide = library.records.find(record => record.id === ORIGINAL_HIDE_ID);
  if (hide.appKey !== appKey || hide.name !== 'Hide Sidebar Voice Button' || !hide.isEnabled || hide.sourceType !== 'css') throw new Error('The exact original Hide Voice record is no longer enabled CSS.');
  const others = library.records.filter(record => record.appKey === appKey && record.isEnabled && record.id !== ORIGINAL_HIDE_ID).map(record => record.id);
  if (others.length !== 1 || others[0] !== '0215A2E4-50D5-4FB3-8645-E7692DB3B9C2') throw new Error('The original New Chat customization must remain enabled for this fixed proof.');
  return others;
}

export function assertVoiceRevision(session, { enabledIDs, ownedID, ownedEnabled, display }) {
  const { status, report } = session;
  const current = report.revisions?.[status.revision - 1];
  if (status.appKey !== appKey || report.appKey !== appKey || status.phase !== 'active' || status.revision !== report.revisions?.length ||
      !isDeepStrictEqual(status.enabledExtensionIDs, enabledIDs) || !isDeepStrictEqual(current?.enabledExtensionIDs, enabledIDs) ||
      enabledIDs.includes(ownedID) !== ownedEnabled || current?.stylesheetReadbackVerified !== true || current.signatureUnchanged !== true ||
      status.signatureUnchanged !== true || status.voice?.matches !== 1 || status.voice.display !== display ||
      current.appliedVoice?.matches !== 1 || current.appliedVoice.display !== display) throw new Error('The current owned Voice revision, exact enabled IDs and computed display are not verified.');
  return current;
}

export function assertOriginalRecordsRestored(current, snapshot) {
  if (!isDeepStrictEqual(current.records, snapshot.records)) throw new Error('Original records or their order differ from the snapshot; no broad rollback was attempted.');
}

async function verifyFooterPNGs(session, ownedID) {
  for (const revision of session.report.revisions) {
    if (!revision.enabledExtensionIDs.includes(ownedID)) continue;
    for (const file of [revision.screenshots?.before, revision.screenshots?.after]) {
      if (typeof file !== 'string' || path.basename(file) !== file || !file.endsWith('.png')) throw new Error('Required owned Voice footer screenshot is missing.');
      await requirePNG(path.join(session.sessionDirectory, file));
    }
  }
}

export async function runChatGPTNativeE2E(requestedOutput) {
  const profile = await profileFor(slug), output = await freshEvidenceDirectory(requestedOutput);
  if (path.basename(path.dirname(output)) !== slug || path.basename(path.dirname(path.dirname(output))) !== 'live') throw new Error('Use a fresh live/chatgpt/<trial> directory.');
  const launcherDirectory = path.join(support, 'Launchers', createHash('sha256').update(profile.bundlePath).digest('hex'));
  const report = { slug, app: 'ChatGPT', appKey, profile, launcherDirectory, startedAt: iso(),
    scope: 'Supervised native ChatGPT menu/Voice CSS/restart proof. Temporarily disable only the exact original Hide Voice preference, preserve New Chat and Style Lab, then restore all three original records. Trial processes end; an initially running app is reopened separately using its restored native launcher.',
    actualUpdaterInstallTested: false, steps: [], checks: {}, errors: [], cleanup: {}, visualReview: 'pending' };
  let snapshot, otherIDs, recordID, currentIdentity, originalRegistry, pendingAttempt, preparationAttempted = false, initialSession;
  const identities = [], sessions = new Map();
  let cleaning = false, interruption;
  const onINT = () => { interruption ??= { signal: 'SIGINT', at: iso() }; }, onTERM = () => { interruption ??= { signal: 'SIGTERM', at: iso() }; };
  process.on('SIGINT', onINT); process.on('SIGTERM', onTERM);
  const save = () => writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const failure = (context, error) => report.errors.push({ at: iso(), message: `${context}: ${error.message}`, ...(error.result ? { details: error.result } : {}) });
  const step = async (name, operation) => {
    if (interruption && !cleaning) throw new Error(`Cancelled by ${interruption.signal}.`);
    process.stdout.write(`${iso()} chatgpt: ${name}\n`);
    const item = { name, startedAt: iso() }; report.steps.push(item); await save();
    try { const value = await operation(); item.passed = true; item.finishedAt = iso(); await save(); return value; }
    catch (error) { item.passed = false; item.finishedAt = iso(); item.error = error.message; throw error; }
  };
  const action = (name, number) => harness(name, slug, path.join(output, `${number}-${name}.json`),
    ['prepare-voice', 'restore-voice'].includes(name) ? ORIGINAL_HIDE_ID : name === 'add' ? undefined : recordID);
  const claim = async (session, { attempt = pendingAttempt, postCleanup = false } = {}) => {
    const { status, report: runtime } = session;
    const config = await readBoundedJSON(path.join(launcherDirectory, 'configuration.json'), 65536);
    const broker = await getProcessIdentity(runtime.brokerPid), identity = runtime.processIdentity;
    if (!attempt || !Number.isFinite(attempt.since) || session.sessionDirectory === attempt.exclude ||
        config.profile !== slug || config.targetBundlePath !== profile.bundlePath || config.targetBundleIdentifier !== appKey ||
        config.brokerPath !== path.join(launcherDirectory, 'ChatGPT Launcher.app', 'Contents/Resources/Runtime/scripts/dock-chatgpt-session.mjs') ||
        status.appKey !== appKey || runtime.appKey !== appKey || status.bundle !== profile.bundlePath || runtime.bundle !== profile.bundlePath ||
        !sameProcessIdentity(identity, status.processIdentity) || identity.executable !== profile.executable || identity.uid !== process.getuid() ||
        !sameProcessIdentity(broker, broker) || broker.pid !== status.brokerPid || broker.executable !== await realpath(config.nodePath) || broker.uid !== process.getuid() ||
        Number(broker.started) * 1000 < attempt.since || !Number.isFinite(Date.parse(runtime.startedAt)) || Date.parse(runtime.startedAt) < attempt.since ||
        Number(identity.started) < Number(broker.started) || !sameProcessIdentity(identity, await getProcessIdentity(identity.pid))) throw new Error('The new ChatGPT session is not owned by this invocation.');
    if (postCleanup) return { identity, broker, startedAt: runtime.startedAt };
    identities.push(identity); sessions.set(session.sessionDirectory, { identity, broker, startedAt: runtime.startedAt });
    pendingAttempt = undefined; currentIdentity = identity;
  };
  const voice = (session, enabled) => assertVoiceRevision(session, { enabledIDs: [...otherIDs, ...(enabled ? [recordID] : [])], ownedID: recordID, ownedEnabled: enabled, display: enabled ? 'none' : 'flex' });
  const terminal = async directory => {
    const session = await waitTerminal(directory, launcherDirectory), owned = sessions.get(directory), runtime = session.report;
    if (session.status.phase !== 'stopped' || session.status.error || !Array.isArray(runtime.errors) || runtime.errors.length ||
        runtime.appKey !== appKey || runtime.bundle !== profile.bundlePath || session.status.appKey !== appKey || session.status.bundle !== profile.bundlePath || runtime.startedAt !== owned.startedAt ||
        runtime.brokerPid !== owned.broker.pid || session.status.brokerPid !== owned.broker.pid ||
        !sameProcessIdentity(runtime.processIdentity, owned.identity) || !sameProcessIdentity(session.status.processIdentity, owned.identity) ||
        !Number.isFinite(Date.parse(runtime.finishedAt)) || Date.parse(runtime.finishedAt) < Date.parse(runtime.startedAt) || runtime.unchanged !== true || runtime.cleanup?.controllerDisconnected !== true ||
        runtime.cleanup.targetTerminationRequested !== false || runtime.cleanup.launchedAppLeftRunning !== false || runtime.cleanup.stylesheetRemovalUnresolved ||
        !(runtime.cleanup.stylesheetRemoved || runtime.cleanup.stylesheetEndedWithApp)) throw new Error('ChatGPT terminal cleanup, identity or integrity evidence failed.');
    compareIntegrity(report.before, runtime.before); compareIntegrity(runtime.before, runtime.after); await verifyFooterPNGs(session, recordID);
    const deadline = Date.now() + 3000;
    while (sameProcessIdentity(owned.broker, await getProcessIdentity(owned.broker.pid))) {
      if (Date.now() >= deadline) throw new Error('The finished ChatGPT broker remains running.'); await delay(100);
    }
    return session;
  };
  try {
    await step('require unlocked desktop', requireUnlockedDesktop);
    snapshot = await readBoundedJSON(libraryFile, 64 * 1024 * 1024); otherIDs = validateOriginalRecords(snapshot);
    await writeFile(path.join(output, 'original-library.json'), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    report.originalRecordIDs = snapshot.records.map(record => record.id);
    report.before = await step('strict installed signature and bundle fingerprint', () => inspectIntegrity(profile.bundlePath));
    originalRegistry = await registration(profile); report.originalRunning = originalRegistry;
    if (originalRegistry.length > 1) throw new Error('Multiple ChatGPT instances are registered.');
    let previous; try { previous = (await readSession(launcherDirectory)).sessionDirectory; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (originalRegistry.length === 1) {
      const prior = await getProcessIdentity(originalRegistry[0].pid);
      if (!sameProcessIdentity(prior, prior) || prior.executable !== profile.executable || prior.uid !== process.getuid()) throw new Error('Pre-existing ChatGPT identity cannot be verified.');
      identities.push(prior); report.preexistingIdentity = prior;
      report.preexistingQuit = await step('normal quit of explicitly tracked pre-existing ChatGPT', () => normalQuit(profile, prior));
      if (previous) {
        await waitTerminal(previous, launcherDirectory);
        await cp(previous, path.join(output, 'pre-existing-session'), { recursive: true, force: false, errorOnExist: true });
      }
    }
    preparationAttempted = true;
    await step('temporarily disable exact original Hide Voice preference', () => action('prepare-voice', '00'));
    const added = await step('add fresh owned Voice CSS', () => action('add', '01'));
    recordID = added.recordID; report.recordID = recordID;
    if (added.after.launcherDirectory !== launcherDirectory) throw new Error('Unexpected ChatGPT launcher directory.');
    pendingAttempt = { since: Date.now(), exclude: previous };
    await step('launch through actual ChatGPT menu item', () => launchFromMenu(profile, path.join(output, 'initial-menu'))); report.checks.menuLaunch = true;
    initialSession = await step('verify fresh owned Voice runtime', () => waitSession(launcherDirectory, 'active', { profile, excludeSessionDirectory: previous }));
    await claim(initialSession); const first = voice(initialSession, true);
    if (first.originalVoice?.display !== 'flex') throw new Error('Fresh Voice baseline was not visibly present before owned CSS.');
    report.checks.initialVoiceHidden = true; report.checks.initialLaunch = true; report.checks.CSSReadback = true; report.initialPID = currentIdentity.pid;
    const healthy = await step('native healthy snapshot', () => action('inspect', '02'));
    if (healthy.after.runtime?.healthy !== true || healthy.after.runtime.pid !== currentIdentity.pid) throw new Error('Initial ChatGPT runtime is not healthy in the native manager.');
    report.checks.nativeHealthy = true;
    await step('capture actual ChatGPT with owned Voice CSS', () => captureWholeApp(currentIdentity.pid, path.join(output, 'whole-app-enabled.png')));
    const revision = initialSession.status.revision;
    await step('disable only owned Voice test record', () => action('disable', '03'));
    const disabled = await waitVoiceRevision(revision, false); report.checks.disableRestore = true;
    await step('capture actual ChatGPT with Voice restored', () => captureWholeApp(currentIdentity.pid, path.join(output, 'whole-app-disabled.png')));
    await step('re-enable owned Voice test record', () => action('enable', '04'));
    await waitVoiceRevision(disabled.status.revision, true); report.checks.reenable = true;
    report.managedQuit = await step('normal quit of owned managed ChatGPT', () => normalQuit(profile, currentIdentity)); currentIdentity = null;
    await terminal(initialSession.sessionDirectory);
    const normalStarted = Date.now(); report.normalOpen = await step('ordinary original-app launch', () => normalOpen(profile));
    for (let i = 0; i < 80; i++) {
      const rows = await registration(profile);
      if (rows.length > 1) throw new Error('Multiple ChatGPT instances appeared during ordinary launch.');
      if (rows.length === 1) { const candidate = await getProcessIdentity(rows[0].pid); if (candidate) { currentIdentity = candidate; break; } }
      await delay(250);
    }
    if (!sameProcessIdentity(currentIdentity, currentIdentity) || currentIdentity.executable !== profile.executable || currentIdentity.uid !== process.getuid() || Number(currentIdentity.started) * 1000 < normalStarted) throw new Error('Ordinary launch did not produce the expected fresh ChatGPT process.');
    identities.push(currentIdentity); report.normalIdentity = currentIdentity; report.normalPID = currentIdentity.pid;
    await step('capture ordinary ChatGPT before restart prompt', () => captureWholeApp(currentIdentity.pid, path.join(output, 'whole-app-normal-relaunch.png')));
    pendingAttempt = { since: Date.now(), exclude: initialSession.sessionDirectory };
    report.prompt = await step('accept actual ChatGPT restart alert', () => acceptRestartPrompt(profile, currentIdentity.pid, path.join(output, 'restart'), { since: normalStarted }));
    pendingAttempt.since = Date.parse(report.prompt.clickedAt); report.checks.restartAccepted = true; report.checks.promptShown = true;
    const restarted = await step('verify new connected ChatGPT after restart', () => waitSession(launcherDirectory, 'active', { profile, excludePID: currentIdentity.pid, excludeSessionDirectory: initialSession.sessionDirectory }));
    await claim(restarted); voice(restarted, true); report.checks.restartRestored = true; report.newConnectedPID = currentIdentity.pid;
    const afterRestart = await step('native healthy snapshot after restart', () => action('inspect', '05'));
    if (afterRestart.after.runtime?.healthy !== true || afterRestart.after.runtime.pid !== currentIdentity.pid) throw new Error('Restarted ChatGPT runtime is not healthy in the native manager.');
    await step('capture restarted ChatGPT with Voice hidden', () => captureWholeApp(currentIdentity.pid, path.join(output, 'whole-app-after-restart.png')));
    await step('activate connected ChatGPT through actual menu', () => launchFromMenu(profile, path.join(output, 'restored-menu')));
    const rows = await registration(profile);
    if (rows.length !== 1 || rows[0].pid !== currentIdentity.pid || !sameProcessIdentity(currentIdentity, await getProcessIdentity(rows[0].pid))) throw new Error('Menu activation changed the connected ChatGPT identity.');
    report.checks.menuActivation = true;
  } catch (error) {
    if (!recordID && error.result?.action === 'add' && error.result.recordID) { recordID = error.result.recordID; report.recordID = recordID; }
    failure('ChatGPT flow', error);
  } finally {
    cleaning = true;
    if (pendingAttempt) { try { await claim(await readSession(launcherDirectory)); } catch (error) { failure('Unclaimed launch left for inspection', error); } }
    if (recordID) {
      try { await step('remove only owned test record', () => action('remove', '90')); report.cleanup.recordRemoved = true; }
      catch (error) { failure('Owned record removal', error); }
    }
    if (preparationAttempted) {
      try { await step('restore exact original Hide Voice preference', () => action('restore-voice', '91')); report.cleanup.originalVoiceRestored = true; }
      catch (error) { failure('Original Voice restoration requires supervised recovery', error); }
    }
    if (snapshot) {
      try { assertOriginalRecordsRestored(await readBoundedJSON(libraryFile, 64 * 1024 * 1024), snapshot); report.cleanup.originalRecordsPreserved = true; }
      catch (error) { failure('Original library comparison', error); }
    }
    report.cleanup.dockRestored = report.cleanup.recordRemoved === true && report.cleanup.originalVoiceRestored === true && report.cleanup.originalRecordsPreserved === true;
    report.cleanup.dockStateScope = 'Production remove/restore actions completed with the three original configured records; no whole-Dock rollback.';
    if (originalRegistry) {
      try {
        const rows = await registration(profile);
        if (!rows.length) report.cleanup.appAlreadyExited = true;
        else {
          const live = rows.length === 1 ? await getProcessIdentity(rows[0].pid) : null;
          if (isTrackedIdentity(live, identities)) report.cleanup.normalQuit = await normalQuit(profile, live);
          else { report.cleanup.appLeftRunning = true; throw new Error('An untracked ChatGPT instance remains; it was not quit.'); }
        }
      } catch (error) { failure('App cleanup', error); }
    }
    report.cleanup.sessionsVerified = sessions.size === 2; report.cleanup.evidenceCopied = sessions.size === 2;
    let index = 0;
    for (const [directory] of sessions) {
      try { await terminal(directory); } catch (error) { report.cleanup.sessionsVerified = false; failure('Terminal evidence', error); }
      try { await readExactSession(directory, launcherDirectory); await cp(directory, path.join(output, `session-final-${++index}`), { recursive: true, force: false, errorOnExist: true }); }
      catch (error) { report.cleanup.evidenceCopied = false; failure('Evidence copy', error); }
    }
    if (originalRegistry?.length === 1 && report.preexistingQuit && report.cleanup.originalRecordsPreserved && !report.cleanup.appLeftRunning) {
      try {
        if ((await registration(profile)).length) throw new Error('An app is already registered; separate restoration will not substitute it.');
        const excluded = (await readSession(launcherDirectory)).sessionDirectory;
        const since = Date.now();
        report.postCleanupReopen = { requestedAt: iso(), scope: 'Separate ongoing session restoring the initially running app with only its original configured extensions. It is not one of the two completed E2E sessions.' };
        await exec('/usr/bin/open', [path.join(launcherDirectory, 'ChatGPT.app')], { timeout: 15000, maxBuffer: 16384 });
        const reopened = await waitSession(launcherDirectory, 'active', { profile, excludeSessionDirectory: excluded });
        const reopenedOwned = await claim(reopened, { attempt: { since, exclude: excluded }, postCleanup: true });
        const expected = snapshot.records.filter(record => record.appKey === appKey && record.isEnabled).map(record => record.id);
        assertVoiceRevision(reopened, { enabledIDs: expected, ownedID: recordID, ownedEnabled: false, display: 'none' });
        const observed = await harness('inspect', slug, path.join(output, '98-restored-inspect.json'));
        if (observed.after.runtime?.healthy !== true || observed.after.runtime.pid !== reopenedOwned.identity.pid) throw new Error('The separate restored session is not healthy in the native manager.');
        assertOriginalRecordsRestored(await readBoundedJSON(libraryFile, 64 * 1024 * 1024), snapshot);
        report.postCleanupReopen = { ...report.postCleanupReopen, processIdentity: reopenedOwned.identity, brokerIdentity: reopenedOwned.broker, sessionDirectory: reopened.sessionDirectory, healthy: true, originalRecordsPreserved: true };
        await cp(reopened.sessionDirectory, path.join(output, 'post-cleanup-reopen'), { recursive: true, force: false, errorOnExist: true });
        report.cleanup.initialRunningStateRestored = true;
      } catch (error) { failure('Separate original-running-state restoration', error); }
    }
    try { report.after = await inspectIntegrity(profile.bundlePath); report.checks.signatureUnchanged = report.before ? compareIntegrity(report.before, report.after).unchanged : false; }
    catch (error) { failure('Final integrity', error); }
    try { report.events = await saveEvents(profile, path.join(output, 'native-events.json'), Date.parse(report.startedAt)); } catch (error) { failure('Native event evidence', error); }
    if (interruption) report.interruption = interruption;
    report.finishedAt = iso(); report.automatedFlowPassed = !interruption && report.errors.length === 0 && report.steps.every(item => item.passed === true) &&
      ['menuLaunch', 'initialVoiceHidden', 'nativeHealthy', 'disableRestore', 'reenable', 'restartAccepted', 'restartRestored', 'menuActivation', 'signatureUnchanged'].every(key => report.checks[key] === true) &&
      ['recordRemoved', 'originalVoiceRestored', 'originalRecordsPreserved', 'dockRestored', 'sessionsVerified', 'evidenceCopied'].every(key => report.cleanup[key] === true) && !report.cleanup.appLeftRunning &&
      (originalRegistry?.length !== 1 || report.cleanup.initialRunningStateRestored === true);
    report.status = report.automatedFlowPassed ? 'awaiting-visual-review' : 'failed';
    try { await save(); } finally { process.off('SIGINT', onINT); process.off('SIGTERM', onTERM); }
  }
  return report;

  async function waitVoiceRevision(afterRevision, enabled) {
    const deadline = Date.now() + 15000;
    do {
      if (interruption) throw new Error(`Cancelled by ${interruption.signal}.`);
      const session = await waitSession(launcherDirectory, 'active', { profile, newPID: currentIdentity.pid, timeoutMs: 15000 });
      if (!sessions.has(session.sessionDirectory) || !sameProcessIdentity(session.identity, currentIdentity)) throw new Error('Voice toggle changed the owned app session.');
      if (session.status.revision > afterRevision) { voice(session, enabled); return session; }
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error('The owned Voice preference revision did not update.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw new Error('Usage: chatgpt-native-e2e.mjs <new live/chatgpt/trial directory>');
  if (!(await runChatGPTNativeE2E(output)).automatedFlowPassed) process.exitCode = 1;
}
