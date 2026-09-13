// Explicit E2E recovery only. Importing this module performs no app actions.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getProcessIdentity, sameProcessIdentity } from '../../lib/process-identity.mjs';
import { profileFor, readSession, registration } from './catalog-e2e.mjs';

const exec = promisify(execFile);
const iso = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const pid = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const date = value => typeof value === 'string' ? Date.parse(value) : NaN;
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value);

async function json(file, maximum = 16384) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > maximum || await realpath(file) !== file) throw new Error('Recovery metadata must be bounded canonical regular files.');
  const data = await readFile(file);
  if (data.length > maximum) throw new Error('Recovery metadata grew beyond its bound.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}

async function helperRegistry(identifier) {
  const script = `ObjC.import('AppKit');var out=[],apps=$.NSWorkspace.sharedWorkspace.runningApplications;
    for(var i=0;i<apps.count;i++){var a=apps.objectAtIndex(i);if(!a.isTerminated&&ObjC.unwrap(a.bundleIdentifier)===${JSON.stringify(identifier)})out.push({pid:Number(a.processIdentifier),bundleIdentifier:ObjC.unwrap(a.bundleIdentifier),bundlePath:ObjC.unwrap(a.bundleURL.path),executable:ObjC.unwrap(a.executableURL.path)});}JSON.stringify(out);`;
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { cwd: '/', timeout: 5000, maxBuffer: 65536 });
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length > 16 || rows.some(row => !pid(row?.pid) || row.bundleIdentifier !== identifier || !absolute(row.bundlePath) || !absolute(row.executable))) throw new Error('Invalid helper application registry.');
  return rows;
}

/** Pure eligibility gate. Historical errors alone never establish ownership. */
export function failedLauncherEligibility(value) {
  if (!value || typeof value !== 'object') return { eligible: false, reasons: ['Ownership metadata is incomplete.'] };
  const reasons = [];
  const { profile, helper, identity, config, info, session, launcherDirectory, uid } = value;
  const fail = (condition, reason) => { if (!condition) reasons.push(reason); };
  fail(Array.isArray(value.targetRegistrations) && value.targetRegistrations.length === 0, 'The original app is not confirmed stopped.');
  fail(value.helperRegistrations?.length === 1, 'The helper is absent or ambiguous.');
  if (!profile || !helper || !identity || !config || !info || !session?.status || !session?.report || !absolute(helper.bundlePath) || !absolute(launcherDirectory)) return { eligible: false, reasons: [...reasons, 'Ownership metadata is incomplete.'] };
  fail(value.helperRegistrations?.[0]?.pid === helper.pid && value.helperRegistrations?.[0]?.bundlePath === helper.bundlePath && value.helperRegistrations?.[0]?.executable === helper.executable && value.helperRegistrations?.[0]?.bundleIdentifier === helper.bundleIdentifier,
    'The selected helper does not match its sole registry entry.');
  const helperID = `dev.extensionsanywhere.launcher.${profile.slug}`;
  fail(absolute(helper.bundlePath) && path.dirname(helper.bundlePath) === launcherDirectory && path.basename(helper.bundlePath).endsWith(' Launcher.app'), 'Helper bundle is outside the exact generated launcher directory.');
  fail(helper.bundleIdentifier === helperID && helper.executable === path.join(helper.bundlePath, 'Contents/MacOS/ExtensionLauncher'), 'Helper registry identity does not match the generated wrapper.');
  fail(sameProcessIdentity(identity, identity) && identity.pid === helper.pid && identity.executable === helper.executable && identity.uid === uid, 'Helper kernel PID/start/executable/UID is not verified.');
  fail(value.canonicalPaths === true && value.signatureValid === true, 'Helper paths or strict signature are not verified.');
  fail(info.CFBundleIdentifier === helperID && info.CFBundleExecutable === 'ExtensionLauncher' && info.LSUIElement === true && /^[a-f0-9]{64}$/.test(info.EALauncherSourceSHA256 ?? ''), 'Helper bundle metadata does not match our generated app.');
  fail(config.schemaVersion === 1 && config.profile === profile.slug && config.targetBundlePath === profile.bundlePath && config.targetBundleIdentifier === profile.bundleIdentifier &&
    config.sessionsPath === path.join(launcherDirectory, 'Sessions') && config.libraryPath === value.expectedLibraryPath &&
    config.brokerPath === path.join(helper.bundlePath, 'Contents/Resources/Runtime/scripts/dock-catalog-session.mjs') && absolute(config.nodePath), 'The fixed packaged-launcher configuration changed or is invalid.');
  const { status, report } = session;
  fail(status?.phase === 'error' && status.pid === null && Array.isArray(report?.errors) && report.errors.length > 0 && Number.isFinite(date(report.finishedAt)), 'The prior session is not a terminal failed session.');
  fail(status?.slug === profile.slug && report?.slug === profile.slug && status.appKey === profile.bundleIdentifier && report.appKey === profile.bundleIdentifier &&
    status.bundle === profile.bundlePath && report.bundle === profile.bundlePath && pid(report.brokerPid) && report.brokerPid !== helper.pid && report.brokerPid === status.brokerPid &&
    status.startedAt === report.startedAt, 'The prior session does not identify this fixed app and broker.');
  const started = date(report?.startedAt), finished = date(report?.finishedAt), helperStarted = Number(identity.started) * 1000;
  fail(Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= value.observedAtMs + 1000 &&
    date(status?.updatedAt) >= finished && helperStarted <= started + 1 && started - helperStarted <= 60000,
    'The helper lifetime cannot be tied to the prior session.');
  fail(value.brokerProcess === null, 'The prior broker is still present or its absence is unresolved.');
  if (report?.processIdentity) {
    fail(sameProcessIdentity(report.processIdentity, report.processIdentity) && report.processIdentity.executable === profile.executable && report.processIdentity.uid === uid,
      'The prior target identity is malformed.');
    fail(value.priorTargetProcess === null || (sameProcessIdentity(value.priorTargetProcess, value.priorTargetProcess) && value.priorTargetProcess.pid === report.processIdentity.pid && value.priorTargetProcess.started !== report.processIdentity.started),
      'The original target process has not been confirmed ended.');
  } else fail(report?.cleanup?.noAppLaunched === true && report.launchOutcomeUnknown === false, 'Prior target launch outcome is unresolved.');
  return { eligible: reasons.length === 0, reasons };
}

export async function inspectFailedCatalogLauncher(slug) {
  const profile = await profileFor(slug);
  if (!profile.runtimeSupported || !profile.target) throw new Error('Failed-helper recovery is limited to fixed ordinary catalog profiles.');
  const support = path.join(os.homedir(), 'Library/Application Support/Extensions Anywhere');
  const launcherDirectory = path.join(support, 'Launchers', hash(profile.bundlePath));
  const targetRegistrations = await registration(profile);
  const helperRegistrations = await helperRegistry(`dev.extensionsanywhere.launcher.${slug}`);
  const value = { schemaVersion: 1, observedAt: iso(), observedAtMs: Date.now(), uid: process.getuid(), profile,
    launcherDirectory, expectedLibraryPath: path.join(support, 'library.json'), targetRegistrations, helperRegistrations,
    eligible: false, reasons: [], outcome: 'blocked' };
  if (!helperRegistrations.length) return { ...value, outcome: targetRegistrations.length ? 'target-running' : 'no-helper', reasons: targetRegistrations.length ? ['The original app is running.'] : [] };
  if (helperRegistrations.length !== 1) return { ...value, reasons: ['Multiple generated helper instances are registered.'] };
  try {
    value.helper = helperRegistrations[0];
    if (path.dirname(value.helper.bundlePath) !== launcherDirectory || !path.basename(value.helper.bundlePath).endsWith(' Launcher.app') || value.helper.executable !== path.join(value.helper.bundlePath, 'Contents/MacOS/ExtensionLauncher')) throw new Error('Helper path is not the exact generated wrapper.');
    value.identity = await getProcessIdentity(value.helper.pid);
    value.config = await json(path.join(launcherDirectory, 'configuration.json'));
    value.session = await readSession(launcherDirectory);
    const infoPath = path.join(value.helper.bundlePath, 'Contents/Info.plist');
    for (const file of [launcherDirectory, value.helper.bundlePath, value.helper.executable, infoPath, value.config.brokerPath, value.config.nodePath]) {
      if (!absolute(file) || await realpath(file) !== file) throw new Error('A recovery path resolves through a different location.');
    }
    value.canonicalPaths = true;
    value.info = JSON.parse((await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath], { cwd: '/', timeout: 5000, maxBuffer: 65536 })).stdout);
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', value.helper.bundlePath], { cwd: '/', timeout: 10000, maxBuffer: 65536 });
    value.signatureValid = true;
    value.brokerProcess = await getProcessIdentity(value.session.report.brokerPid);
    if (value.session.report.processIdentity) value.priorTargetProcess = await getProcessIdentity(value.session.report.processIdentity.pid);
    Object.assign(value, failedLauncherEligibility(value));
    value.evidenceSHA256 = hash(JSON.stringify({ helper: value.helper, identity: value.identity, config: value.config, info: value.info, session: value.session }));
    value.outcome = value.eligible ? 'eligible-failed-helper' : 'blocked';
  } catch (error) { value.reasons.push(error.message); }
  return value;
}

/** Orchestration exposed for synthetic tests; the public slug API binds live operations below. */
export async function recoverObservedFailedLauncher({ inspect, requestNormalTermination, waitForExit, save }) {
  const result = { startedAt: iso(), scope: 'Explicit E2E preflight: normal close of one verified previously failed generated helper only.', targetTerminationRequested: false, forceAttempted: false };
  try {
    result.before = await inspect(); await save(result);
    if (result.before.outcome === 'no-helper') { result.outcome = 'no-helper'; return result; }
    if (!result.before.eligible) throw new Error(result.before.reasons.join(' ') || 'Failed-helper ownership is not established.');
    result.revalidated = await inspect();
    if (!result.revalidated.eligible || result.revalidated.evidenceSHA256 !== result.before.evidenceSHA256 || !sameProcessIdentity(result.before.identity, result.revalidated.identity)) throw new Error('Failed-helper evidence changed before termination; nothing was closed.');
    await save(result);
    result.normalQuitAccepted = await requestNormalTermination(result.revalidated);
    if (result.normalQuitAccepted !== true) throw new Error('The helper declined normal termination; no force was attempted.');
    await save(result);
    result.exit = await waitForExit(result.revalidated);
    result.outcome = 'closed-failed-helper';
    return result;
  } catch (error) { result.outcome = 'blocked'; result.error = error.message; throw Object.assign(error, { observation: result }); }
  finally { result.finishedAt = iso(); await save(result); }
}

export async function closeFailedCatalogLauncher(slug, outputPath) {
  if (!absolute(outputPath) || !outputPath.endsWith('.json') || outputPath.split(path.sep).some(part => part.toLowerCase().endsWith('.app')) || await realpath(path.dirname(outputPath)) !== path.dirname(outputPath)) throw new Error('Use a fresh JSON evidence file in an existing canonical directory outside app bundles.');
  let previous;
  const save = async result => {
    const data = JSON.stringify(result, null, 2) + '\n';
    if (previous === undefined) await writeFile(outputPath, data, { flag: 'wx', mode: 0o600 });
    else {
      if (await readFile(outputPath, 'utf8') !== previous) throw new Error('Recovery observation changed externally; it was preserved.');
      const temporary = `${outputPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await rename(temporary, outputPath);
    }
    previous = data;
  };
  return recoverObservedFailedLauncher({ inspect: () => inspectFailedCatalogLauncher(slug), save,
    requestNormalTermination: async value => {
      if ((await registration(value.profile)).length || !sameProcessIdentity(value.identity, await getProcessIdentity(value.identity.pid))) throw new Error('The target or helper changed immediately before termination.');
      const script = `ObjC.import('AppKit');var apps=$.NSWorkspace.sharedWorkspace.runningApplications;
        for(var i=0;i<apps.count;i++){var x=apps.objectAtIndex(i);if(!x.isTerminated&&(ObjC.unwrap(x.bundleIdentifier)===${JSON.stringify(value.profile.bundleIdentifier)}||ObjC.unwrap(x.bundleURL.path)===${JSON.stringify(value.profile.bundlePath)}))throw Error('Original app is running');}
        var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${value.identity.pid});
        if(!a||a.isTerminated||ObjC.unwrap(a.bundleIdentifier)!==${JSON.stringify(value.helper.bundleIdentifier)}||ObjC.unwrap(a.bundleURL.path)!==${JSON.stringify(value.helper.bundlePath)}||ObjC.unwrap(a.executableURL.path)!==${JSON.stringify(value.helper.executable)})throw Error('Helper identity changed');JSON.stringify({accepted:Boolean(a.terminate)});`;
      return JSON.parse((await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { cwd: '/', timeout: 5000, maxBuffer: 16384 })).stdout).accepted === true;
    },
    waitForExit: async value => {
      const deadline = Date.now() + 5000;
      do {
        const current = await getProcessIdentity(value.identity.pid);
        const helpers = await helperRegistry(value.helper.bundleIdentifier);
        if (current === null && helpers.length === 0) return { kernelAbsent: true, helperRegistryEmpty: true, at: iso() };
        if (current && !sameProcessIdentity(current, value.identity)) throw new Error('Helper PID identity changed; the replacement was left alone.');
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw new Error('The helper did not finish normal termination within five seconds; no force was attempted.');
    }
  });
}
