// One stopped, fixed catalog app. No menu, alert, or WindowServer automation.
import path from 'node:path';
import { cp, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { profileFor, harness, registration, normalQuit, readSession, waitSession } from './lib/catalog-e2e.mjs';
import { freshEvidenceDirectory, isTrackedIdentity, assertCurrentGreen, assertSessionOwnership,
  assertTerminalEvidence, readExactSession, waitTerminal, verifySessionPNGs } from './catalog-native-e2e.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../lib/process-identity.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';
import { readBoundedJSON } from '../lib/catalog-stylesheet.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const iso = () => new Date().toISOString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runNativeBackground(slug, requestedOutput) {
  const profile = await profileFor(slug);
  if (!profile.runtimeSupported || ['chatgpt', 'stylelab'].includes(slug)) throw new Error('This runner requires a fixed ordinary catalog runtime profile.');
  const requested = path.resolve(requestedOutput);
  if (!/^background-trial-[1-9]\d*$/.test(path.basename(requested)) || path.basename(path.dirname(requested)) !== slug ||
      path.basename(path.dirname(path.dirname(requested))) !== 'live') throw new Error('Use a new live/<slug>/background-trial-N evidence directory.');
  const output = await freshEvidenceDirectory(requested);
  const report = { schemaVersion: 1, slug, app: profile.name, profile, startedAt: iso(),
    scope: 'Background native manager CSS only: add/open, current readback and computed control, disable/enable, owned removal and normal quit. Broker PNGs only; no WindowServer capture or lock interaction.',
    fullAppVisual: 'pending', menu: 'pending', prompt: 'pending', restart: 'pending', actualUpdaterInstallTested: false,
    automatedFlowPassed: false, backgroundCSSPassed: false, visualReview: 'pending', steps: [], checks: {}, errors: [], cleanup: {} };
  let recordID, launcherDirectory, initialRegistry, owned, pendingAttempt;
  let cleaning = false, interruption;
  const interrupt = signal => { interruption ??= { signal, at: iso() }; };
  const onINT = () => interrupt('SIGINT'), onTERM = () => interrupt('SIGTERM');
  process.on('SIGINT', onINT); process.on('SIGTERM', onTERM);
  const save = () => writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const fail = (context, error) => report.errors.push({ at: iso(), message: `${context}: ${error.message}`, ...(error.result ? { details: error.result } : {}) });
  const step = async (name, operation) => {
    if (interruption && !cleaning) throw new Error(`Cancelled by ${interruption.signal} before ${name}.`);
    process.stdout.write(`${iso()} ${slug}: ${name}\n`);
    const item = { name, startedAt: iso() }; report.steps.push(item); await save();
    try { const value = await operation(); item.passed = true; item.finishedAt = iso(); await save(); return value; }
    catch (error) { item.passed = false; item.finishedAt = iso(); item.error = error.message; throw error; }
  };
  const action = (name, number) => harness(name, slug, path.join(output, `${number}-${name}.json`), name === 'add' ? undefined : recordID);
  const claim = async session => {
    const config = await readBoundedJSON(path.join(launcherDirectory, 'configuration.json'), 64 * 1024);
    if (config.profile !== profile.slug || config.targetBundlePath !== profile.bundlePath || config.targetBundleIdentifier !== profile.bundleIdentifier ||
        config.brokerPath !== path.join(launcherDirectory, `${profile.name} Launcher.app`, 'Contents/Resources/Runtime/scripts/dock-catalog-session.mjs')) throw new Error('Launcher configuration does not match this fixed trial.');
    const broker = await getProcessIdentity(session.report.brokerPid);
    const identity = assertSessionOwnership(session, profile, pendingAttempt, broker, await realpath(config.nodePath));
    if (!sameProcessIdentity(identity, await getProcessIdentity(identity.pid))) throw new Error('Claimed app has exited or changed identity.');
    owned = { sessionDirectory: session.sessionDirectory, identity, broker, startedAt: session.report.startedAt };
    report.processIdentity = identity; report.sessionDirectory = owned.sessionDirectory; report.brokerIdentity = broker;
    pendingAttempt = undefined;
  };
  const assertRestored = session => {
    if (session.sessionDirectory !== owned.sessionDirectory || !sameProcessIdentity(session.report.processIdentity, owned.identity) ||
        session.status.phase !== 'disabled' || session.status.enabledExtensionIDs?.length !== 0 ||
        !session.report.revisions?.slice(-2, -1).some(revision => revision.enabledExtensionIDs?.includes(recordID) &&
          revision.restoration?.reason === 'disabled' && revision.restoration.baselineMatches === true && revision.restoration.stylesheetReadbackVerified === true)) {
      throw new Error('The owned extension did not restore the current control baseline.');
    }
  };
  try {
    initialRegistry = await step('require original app stopped', () => registration(profile)); report.initialRunning = initialRegistry;
    if (initialRegistry.length) throw new Error('The original app is already running; no record or app state will be changed.');
    report.before = await step('strict signature and full bundle fingerprint before', () => inspectIntegrity(profile.bundlePath));
    const added = await step('add temporary CSS through production manager', () => action('add', '01'));
    recordID = added.recordID; launcherDirectory = added.after.launcherDirectory;
    report.recordID = recordID; report.launcherDirectory = launcherDirectory;
    profile.name = added.app.name; report.app = profile.name;
    let previous;
    try { previous = (await readSession(launcherDirectory)).sessionDirectory; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    pendingAttempt = { since: Date.now(), exclude: previous };
    await step('open through production manager', () => action('open', '02')); report.checks.nativeOpen = true;
    const active = await step('verify connected current CSS revision', () => waitSession(launcherDirectory, 'active', { profile, excludeSessionDirectory: previous }));
    await claim(active); assertCurrentGreen(active, recordID); report.checks.currentCSS = true;
    const healthy = await step('inspect native healthy session', () => action('inspect', '03'));
    if (healthy.after.runtime?.healthy !== true || healthy.after.runtime.pid !== owned.identity.pid) throw new Error('Native manager does not consider the owned runtime healthy.');
    report.checks.nativeHealthy = true;
    await step('disable owned CSS through production manager', () => action('disable', '04'));
    const disabled = await step('verify disable restoration', () => waitSession(launcherDirectory, 'disabled', { profile, newPID: owned.identity.pid }));
    assertRestored(disabled); report.checks.disableRestore = true;
    await step('re-enable owned CSS through production manager', () => action('enable', '05'));
    const enabled = await step('verify current re-enabled CSS', () => waitSession(launcherDirectory, 'active', { profile, newPID: owned.identity.pid }));
    if (enabled.sessionDirectory !== owned.sessionDirectory || !sameProcessIdentity(enabled.identity, owned.identity)) throw new Error('Re-enable changed the owned session.');
    assertCurrentGreen(enabled, recordID); report.checks.reenable = true;
  } catch (error) {
    if (!recordID && error.result?.recordID) { recordID = error.result.recordID; launcherDirectory = error.result.after?.launcherDirectory; report.recordID = recordID; report.launcherDirectory = launcherDirectory; }
    fail('Background flow', error);
  } finally {
    cleaning = true;
    if (interruption) report.interruption = interruption;
    if (pendingAttempt && launcherDirectory) {
      try { await claim(await readSession(launcherDirectory)); }
      catch (error) { fail('Unclaimed launch left for supervised inspection', error); }
    }
    if (recordID) {
      try {
        await step('remove only owned record and restore Dock', () => action('remove', '90'));
        report.cleanup.recordRemoved = true; report.cleanup.dockRestored = true;
      } catch (error) { fail('Remove owned record', error); }
    }
    if (owned) {
      try {
        const current = await readExactSession(owned.sessionDirectory, launcherDirectory);
        if (['active', 'applying', 'disabled'].includes(current.status.phase)) {
          const restored = await waitSession(launcherDirectory, 'disabled', { profile, newPID: owned.identity.pid, timeoutMs: 15000 });
          assertRestored(restored); report.cleanup.removalRestored = true;
        } else throw new Error('Owned runtime ended before explicit record-removal restoration could be verified.');
      } catch (error) { fail('Removal restoration', error); }
    }
    if (initialRegistry?.length === 0) {
      try {
        const rows = await registration(profile);
        if (!rows.length) report.cleanup.appAlreadyExited = true;
        else if (rows.length === 1 && owned && isTrackedIdentity(await getProcessIdentity(rows[0].pid), [owned.identity])) {
          report.cleanup.normalQuit = await step('normal quit of exact tracked app', () => normalQuit(profile, owned.identity));
        } else { report.cleanup.appLeftRunning = true; throw new Error('An untracked app instance remains; it was not terminated.'); }
      } catch (error) { report.cleanup.quitError = error.message; report.cleanup.appLeftRunning = true; fail('App cleanup', error); }
    }
    if (owned) {
      try {
        const terminal = await waitTerminal(owned.sessionDirectory, launcherDirectory);
        assertTerminalEvidence(terminal, owned, profile, report.before); await verifySessionPNGs(terminal);
        const deadline = Date.now() + 3000;
        let broker;
        do { broker = await getProcessIdentity(owned.broker.pid); if (!sameProcessIdentity(owned.broker, broker)) break; await delay(100); } while (Date.now() < deadline);
        if (sameProcessIdentity(owned.broker, broker)) throw new Error('Terminal broker is still running.');
        report.cleanup.sessionVerified = true;
      } catch (error) { fail('Terminal evidence', error); }
      try {
        await readExactSession(owned.sessionDirectory, launcherDirectory);
        await cp(owned.sessionDirectory, path.join(output, 'session'), { recursive: true, errorOnExist: true, force: false });
        report.cleanup.evidenceCopied = true;
      } catch (error) { fail('Evidence copy', error); }
    }
    try {
      report.after = await inspectIntegrity(profile.bundlePath);
      report.checks.signatureUnchanged = report.before ? compareIntegrity(report.before, report.after).unchanged : false;
    } catch (error) { fail('Final integrity', error); }
    report.finishedAt = iso();
    if (interruption) report.interruption = interruption;
    report.backgroundCSSPassed = !interruption && report.errors.length === 0 && report.steps.every(item => item.passed === true) &&
      ['nativeOpen', 'currentCSS', 'nativeHealthy', 'disableRestore', 'reenable', 'signatureUnchanged'].every(key => report.checks[key] === true) &&
      ['recordRemoved', 'dockRestored', 'removalRestored', 'sessionVerified', 'evidenceCopied'].every(key => report.cleanup[key] === true) && !report.cleanup.appLeftRunning;
    report.status = interruption ? 'background-css-cancelled' : report.backgroundCSSPassed ? 'background-css-awaiting-visual-review' : 'background-css-failed';
    try { await save(); }
    finally { process.off('SIGINT', onINT); process.off('SIGTERM', onTERM); }
  }
  process.stdout.write(`${iso()} ${slug}: ${report.status}; ${report.errors.map(error => error.message).join(' | ')}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [slug, output, ...extra] = process.argv.slice(2);
  if (!slug || !output || extra.length) throw new Error('Usage: catalog-native-background.mjs <fixed slug> <new live/slug/background-trial-N directory>');
  const result = await runNativeBackground(slug, output);
  if (!result.backgroundCSSPassed) process.exitCode = 1;
}
