import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ExtensionSessionLogFile, recoverableExtensionFailure } from '../lib/extension-session-logs.mjs';
import { execFile } from 'node:child_process';
import { mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FixtureSession, fixtureBundle, installedFixtureBundle } from '../lib/fixture-session.mjs';
import { FIXTURE_APP_KEY, readFixtureExtensionLibrary } from '../lib/dock-library.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../lib/process-identity.mjs';

const exec = promisify(execFile);
const timestamp = () => new Date().toISOString();
const alive = child => Boolean(child && child.exitCode === null && child.signalCode === null);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FixtureExtensionLogFile extends ExtensionSessionLogFile {
  constructor(file, sessionID, options = {}) { super(file, sessionID, { ...options, appKey: FIXTURE_APP_KEY }); }
}

export function fixtureJSStateProof(states) {
  return states.map(state => ({ extensionID: state.extensionID, revision: state.revision, phase: state.phase,
    generation: state.generation, cleanupComplete: state.cleanupComplete, reloadBlocked: state.reloadBlocked,
    fileNames: [...state.fileNames], ...(state.lastError ? { lastError: { fileName: state.lastError.fileName, stage: state.lastError.stage } } : {}) }));
}

export async function applyFixtureSources(session, selection) {
  const styled = selection.hasCSS ? await session.styles.apply(selection.css) : await session.styles.remove();
  try {
    const jsStates = await session.extensions.sync(selection.jsExtensions);
    return { styled, jsStates: fixtureJSStateProof(jsStates), phase: selection.hasContent ? 'active' : 'disabled' };
  } catch (error) {
    if (!recoverableExtensionFailure(error)) throw error;
    return { styled, jsStates: fixtureJSStateProof(error.states), phase: 'error',
      error: 'One or more extensions failed to load. See their runtime logs.' };
  }
}

export async function restoreFixtureSources(session) {
  let jsStates = [], scriptError;
  try { jsStates = session.extensions ? await session.extensions.sync([]) : []; }
  catch (error) { scriptError = error; }
  // Attempt CSS removal even when cooperative JS cleanup reports uncertainty.
  const restored = await session.styles.remove();
  if (scriptError) throw new Error('Imported JavaScript cleanup failed. See extension logs.');
  return { restored, jsStates };
}

export function fixtureReapplicationUpdate(states, currentStates, count, observedAt = timestamp()) {
  const expected = new Map(currentStates.map(state => [state.extensionID, state.revision]));
  // A delayed load from a replaced selection must not overwrite its successor.
  if (states.length !== expected.size || states.some(state => expected.get(state.extensionID) !== state.revision)) return null;
  if (states.some(state => state.phase !== 'active' || state.reloadBlocked)) throw new Error('Imported JavaScript reapplication did not become active.');
  return { jsStates: fixtureJSStateProof(states), jsReapplications: count, jsReappliedAt: observedAt };
}

export function recordFixtureCleanupResult(session, report) {
  if (!session.extensionCleanupError) return;
  report.cleanup.jsCleanupVerified = false;
  report.cleanup.jsCleanupError = 'Imported extension cleanup was not verified before the controller stopped.';
  if (!report.errors.includes(report.cleanup.jsCleanupError)) report.errors.push(report.cleanup.jsCleanupError);
}

export function parseFixtureApplicationRegistry(stdout) {
  const applications = JSON.parse(stdout);
  if (!Array.isArray(applications) || applications.length > 64) {
    throw new Error('Cannot read the macOS Style Lab application registry.');
  }
  const pids = new Set();
  for (const app of applications) {
    if (!app || !Number.isSafeInteger(app.pid) || app.pid <= 0 || app.pid > 2147483647 ||
        pids.has(app.pid) || app.bundleIdentifier !== FIXTURE_APP_KEY ||
        typeof app.bundlePath !== 'string' || !path.isAbsolute(app.bundlePath) ||
        /[\0\r\n]/.test(app.bundlePath)) {
      throw new Error('The macOS Style Lab application registry returned an invalid identity.');
    }
    pids.add(app.pid);
  }
  return applications;
}

async function fixtureApplicationInventory() {
  // Scope the duplicate-app check to our fixed GUI fixture, as the native
  // launcher does. Unreadable unrelated PIDs are not treated as exited or
  // ignored by the generic kernel inventory. The owned child still requires
  // its own kernel executable, UID, PID and start-time verification below.
  const script = "ObjC.import('AppKit'); var apps=$.NSWorkspace.sharedWorkspace.runningApplications; var result=[]; for (var i=0; i<apps.count; i++) { var app=apps.objectAtIndex(i); if (ObjC.unwrap(app.bundleIdentifier)==='dev.extensionsanywhere.stylelab') result.push({pid:Number(app.processIdentifier),bundleIdentifier:ObjC.unwrap(app.bundleIdentifier),bundlePath:ObjC.unwrap(app.bundleURL.path)}); } JSON.stringify(result);";
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
    timeout: 5000, maxBuffer: 64 * 1024
  });
  return {
    source: 'NSWorkspace.runningApplications', scope: 'fixed-style-lab-bundle-identifier',
    bundleIdentifier: FIXTURE_APP_KEY, applications: parseFixtureApplicationRegistry(stdout)
  };
}

function argumentsFrom(argv) {
  const options = { installedFixture: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--installed-fixture' && !options.installedFixture) options.installedFixture = true;
    else if (['--library', '--output'].includes(flag) && options[flag.slice(2)] === undefined) {
      const value = argv[++index];
      if (!value || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${flag} requires an absolute path.`);
      options[flag.slice(2)] = path.normalize(value);
    } else throw new Error(`Unsupported or repeated argument: ${flag}`);
  }
  if (!options.library || !options.output) throw new Error('Usage: dock-fixture-session.mjs --library <absolute library.json> --output <new session directory> [--installed-fixture]');
  return options;
}

async function safeOutputDirectory(requested) {
  // Resolve the existing ancestor before making any directories. Evidence must
  // never be written into an app bundle, including through a directory symlink.
  let ancestor = requested;
  const remainder = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      remainder.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const output = path.join(ancestor, ...remainder);
  if (output.split(path.sep).some(part => part.toLowerCase().endsWith('.app'))) throw new Error('Evidence must be stored outside app bundles.');
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (const name of ['status.json', 'report.json', 'extension-logs.json']) {
    try { await stat(path.join(output, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Use a new session directory; previous evidence will not be overwritten.');
  }
  return output;
}

async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function runDockFixture(options) {
  const output = await safeOutputDirectory(options.output);
  const bundle = options.installedFixture ? installedFixtureBundle : fixtureBundle;
  let executable = path.join(bundle, 'Contents/MacOS/Style Lab');
  const statusFile = path.join(output, 'status.json');
  const reportFile = path.join(output, 'report.json');
  const sessionID = uuid.test(path.basename(output)) ? path.basename(output) : randomUUID();
  const extensionLogs = new FixtureExtensionLogFile(path.join(output, 'extension-logs.json'), sessionID);
  const session = new FixtureSession({ installedFixture: options.installedFixture, enableButtonDemo: false, enableImportedExtensions: true });
  const report = {
    startedAt: timestamp(), appKey: FIXTURE_APP_KEY, bundle, executable,
    scope: 'Owned Style Lab fixture only; imported CSS and cooperative JavaScript extensions.',
    sessionID,
    transport: 'loopback-tcp', library: options.library, brokerPid: process.pid,
    revisions: [], errors: [], cleanup: {}
  };
  let status = {
    phase: 'starting', brokerPid: process.pid, appKey: FIXTURE_APP_KEY, bundle,
    executable, pid: null, port: null, processIdentity: null,
    enabledExtensionIDs: [], cssBytes: 0, jsBytes: 0, jsStates: [], revision: 0, reportPath: reportFile,
    sessionID,
    heartbeatVersion: 1, startedAt: report.startedAt, phaseStartedAt: report.startedAt
  };
  let lastHeartbeat = 0;
  let stopReason = null, cleanupPromise = null, activeRevision = null, lastSelectionKey = null;
  let pendingJSReapplication = null, jsReapplications = 0;
  let resolveStop;
  const stopping = new Promise(resolve => { resolveStop = resolve; });
  const requestStop = reason => {
    if (stopReason) return;
    stopReason = reason;
    resolveStop();
  };
  const onSIGINT = () => requestStop('SIGINT');
  const onSIGTERM = () => requestStop('SIGTERM');
  process.on('SIGINT', onSIGINT);
  process.on('SIGTERM', onSIGTERM);

  function logPersistenceFailure() {
    if (!report.errors.includes('Extension log persistence failed.')) report.errors.push('Extension log persistence failed.');
    requestStop('extension-log-error');
  }

  async function publish(update = {}) {
    try { await extensionLogs.flush(); }
    catch {
      logPersistenceFailure();
      update = { ...update, phase: 'error', error: 'Extension log persistence failed.' };
    }
    const publishedAt = timestamp();
    if (update.phase && update.phase !== status.phase) status.phaseStartedAt = publishedAt;
    status = { ...status, ...update, updatedAt: publishedAt };
    status.heartbeatAt = status.updatedAt;
    await atomicJSON(reportFile, report);
    await atomicJSON(statusFile, status);
    process.stdout.write(JSON.stringify(status) + '\n');
    lastHeartbeat = Date.now();
  }

  async function heartbeat() {
    if (Date.now() - lastHeartbeat < 2000) return;
    await extensionLogs.flush();
    const heartbeatAt = timestamp();
    status = { ...status, updatedAt: heartbeatAt, heartbeatAt };
    await atomicJSON(statusFile, status);
    lastHeartbeat = Date.now();
  }

  async function capture(folder, name) {
    const { data } = await session.cdp.call('Page.captureScreenshot', { format: 'png' });
    const file = path.join(folder, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'), { mode: 0o600 });
    return path.relative(output, file);
  }

  async function restoreActive(reason) {
    if (!session.styles) return;
    const { restored, jsStates } = await restoreFixtureSources(session);
    assert.deepEqual(restored, session.original, 'Removing CSS must restore the fixture button baseline.');
    if (activeRevision) {
      activeRevision.restored = restored;
      activeRevision.restorationVerified = true;
      activeRevision.restoredAt = timestamp();
      activeRevision.restorationReason = reason;
      activeRevision.jsRestoredStates = fixtureJSStateProof(jsStates);
      activeRevision.screenshots.restored = await capture(activeRevision.folder, 'restored');
      const integrity = await session.verify();
      activeRevision.after = integrity.after;
      activeRevision.unchangedAfter = integrity.unchanged;
      activeRevision = null;
    }
    report.cleanup.lastBaselineVerifiedAt = timestamp();
    report.cleanup.jsCleanupVerified = jsStates.every(state => state.phase === 'disabled' && state.cleanupComplete && !state.reloadBlocked);
  }

  async function applySelection(selection) {
    if (selection.revisionKey === lastSelectionKey) return;
    pendingJSReapplication = null;
    await publish({ phase: 'applying' });
    await restoreActive('library-update');
    if (stopReason) return;
    const revision = report.revisions.length + 1;
    const folder = path.join(output, 'evidence', `${timestamp().replaceAll(':', '-')}-${revision}`);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const entry = {
      revision, recordedAt: timestamp(), folder, cssSha256: selection.sha256,
      cssBytes: selection.cssBytes, enabledExtensionIDs: selection.enabledExtensionIDs,
      jsBytes: selection.jsBytes,
      jsExtensions: selection.jsExtensions.map(({ extensionID, revision, files }) => ({ extensionID, revision,
        files: files.map(({ fileName, text }) => ({ fileName, bytes: Buffer.byteLength(text) })) })),
      sources: selection.sources, screenshots: {}, original: session.original
    };
    report.revisions.push(entry);
    entry.before = (await session.verify()).after;
    entry.screenshots.before = await capture(folder, 'before');
    if (selection.hasContent) {
      // Register the revision before mutation, so partial failures still receive
      // an explicit removal attempt in the single cleanup path.
      activeRevision = entry;
      try {
        const applied = await applyFixtureSources(session, selection);
        entry.styled = applied.styled;
        entry.jsStates = applied.jsStates;
        entry.phase = applied.phase;
        if (applied.error) entry.error = applied.error;
      } catch (error) {
        if (error.states) entry.jsStates = fixtureJSStateProof(error.states);
        throw new Error('Imported extension application failed. See extension logs.');
      }
      entry.screenshots.styled = await capture(folder, 'styled');
      const integrity = await session.verify();
      entry.active = integrity.after;
      entry.unchangedWhileStyled = integrity.unchanged;
    } else {
      entry.restored = await session.styles.remove();
      entry.jsStates = fixtureJSStateProof(await session.extensions.sync([]));
      assert.deepEqual(entry.restored, session.original);
      entry.restorationVerified = true;
      entry.screenshots.restored = await capture(folder, 'restored');
      entry.after = (await session.verify()).after;
      entry.unchangedAfter = true;
    }
    if (stopReason) return;
    pendingJSReapplication = null;
    lastSelectionKey = selection.revisionKey;
    await publish({
      phase: entry.phase ?? (selection.hasContent ? 'active' : 'disabled'), revision,
      enabledExtensionIDs: selection.enabledExtensionIDs, cssBytes: selection.cssBytes,
      jsBytes: selection.jsBytes, jsStates: entry.jsStates,
      error: entry.error ?? null,
      cssSha256: selection.sha256, signatureUnchanged: true
    });
  }

  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      await publish({ phase: 'stopping', stopReason: stopReason || 'error' }).catch(error => report.errors.push(error.message));
      const child = session.child;
      // A normal Quit can close the socket shortly before the child exit event.
      if (alive(child) && stopReason === 'fixture-disconnected') {
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
          const timer = setTimeout(done, 1000);
          child.once('exit', done);
        });
      }
      let mayStopChild = true;
      if (alive(child)) {
        try {
          const current = await getProcessIdentity(child.pid);
          if (!current || current.executable !== executable || current.uid !== process.getuid() ||
              (report.processIdentity && !sameProcessIdentity(report.processIdentity, current))) {
            throw new Error('Fixture process identity changed before cleanup.');
          }
        } catch (error) {
          mayStopChild = false;
          report.errors.push(`Process cleanup refused: ${error.message}`);
          report.cleanup.processIdentityVerified = false;
        }
        try {
          if (!mayStopChild) throw new Error('The process could not be verified; no further renderer commands or process signals were sent.');
          report.cleanup.processIdentityVerified = true;
          await restoreActive('broker-stop');
          report.cleanup.stylesheetRemoved = true;
          report.cleanup.baselineVerifiedBeforeStop = true;
        } catch (error) {
          report.errors.push(`CSS cleanup: ${error.message}`);
          report.cleanup.baselineVerifiedBeforeStop = false;
        }
      } else if (report.launch) {
        report.cleanup.stylesheetRemoved = false;
        report.cleanup.baselineVerifiedBeforeStop = false;
        report.cleanup.restorationUnavailableReason = 'Fixture exited before explicit cleanup; its runtime stylesheet ended with the process.';
        if (activeRevision) activeRevision.endedWithProcess = true;
      }
      // stop() acts only on FixtureSession's own child and temporary profile.
      if (mayStopChild) {
        try { await session.stop(); }
        catch (error) { report.errors.push(`Session cleanup: ${error.message}`); }
        recordFixtureCleanupResult(session, report);
      } else {
        // Fail closed if identity is unresolved: disconnect our controller, but
        // leave the process and its temporary profile untouched for inspection.
        session.cdp?.close();
        session.cdp = null;
        child.stderr?.destroy();
        child.unref();
        report.cleanup.retainedProfile = session.profile;
      }
      report.cleanup.processExited = !alive(child);
      report.cleanup.temporaryProfileRemoved = session.profile === null;
      report.cleanup.controllerDisconnected = session.cdp === null;
      report.cleanup.forcedKill = (child?.signalCode ?? session.lastExit?.signal) === 'SIGKILL';
      if (report.cleanup.forcedKill) report.errors.push('Fixture cleanup required SIGKILL.');
      report.launchArguments = session.launchArguments ?? report.launchArguments ?? null;
      if (session.before) {
        try {
          const integrity = await session.verify();
          report.after = integrity.after;
          report.unchangedAfter = integrity.unchanged;
        } catch (error) { report.errors.push(`Final integrity: ${error.message}`); }
      }
      report.finishedAt = timestamp();
      report.stopReason = stopReason || 'error';
      report.phase = report.errors.length ? 'error' : 'stopped';
      await publish({
        phase: report.phase, pid: null, port: null,
        lastFixturePid: report.launch?.pid ?? null,
        cleanup: report.cleanup, ...(report.errors.length ? { error: report.errors.join(' ') } : {})
      });
      process.off('SIGINT', onSIGINT);
      process.off('SIGTERM', onSIGTERM);
    })();
    return cleanupPromise;
  }

  try {
    await publish();
    const selection = await readFixtureExtensionLibrary(options.library);
    if (!selection.hasContent) throw new Error('No enabled nonempty Style Lab CSS or JavaScript is available. Use a normal launch instead.');
    executable = await realpath(executable);
    report.executable = executable;
    status.executable = executable;
    const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')], { timeout: 5000 });
    if (stdout.trim() !== FIXTURE_APP_KEY) throw new Error('The fixed Style Lab bundle has an unexpected identifier.');
    report.preflight = await fixtureApplicationInventory();
    if (report.preflight.applications.length) throw new Error('Style Lab is already running. Quit it normally before using its tweaked launcher.');
    if (stopReason) return;
    report.launch = await session.start();
    session.extensions.on('console', event => {
      try {
        extensionLogs.append(event).catch(logPersistenceFailure);
      } catch { report.errors.push('Invalid extension log event.'); requestStop('extension-log-error'); }
    });
    session.extensions.on('failure', error => {
      if (recoverableExtensionFailure(error)) {
        const expected = new Map(status.jsStates.map(state => [state.extensionID, state.revision]));
        if (error.states.length === expected.size && error.states.every(state => expected.get(state.extensionID) === state.revision)) {
          pendingJSReapplication = { jsStates: fixtureJSStateProof(error.states), phase: 'error',
            error: 'One or more extensions failed to reload. See their runtime logs.',
            jsReapplications: ++jsReapplications, jsReappliedAt: timestamp() };
        }
      } else { report.errors.push('Imported JavaScript reapplication failed. See extension logs.'); requestStop('javascript-error'); }
    });
    session.extensions.on('reapplied', states => {
      if (stopReason) return;
      try {
        const update = fixtureReapplicationUpdate(states, status.jsStates, ++jsReapplications);
        pendingJSReapplication = update ? { ...update, phase: 'active', error: null } : null;
      } catch {
        report.errors.push('Imported JavaScript reapplication did not become active.');
        requestStop('javascript-error');
      }
    });
    report.launchArguments = [...session.child.spawnargs];
    report.before = session.before;
    report.original = session.original;
    const child = session.child;
    child.once('exit', (code, signal) => {
      report.childExit = { code, signal, observedAt: timestamp() };
      requestStop('fixture-exited');
    });
    if (!alive(child)) requestStop('fixture-exited');
    session.cdp.once('disconnected', () => requestStop('fixture-disconnected'));
    const cdpFailure = error => { report.errors.push(`Debugger connection: ${error.message}`); requestStop('debugger-error'); };
    session.cdp.on('failure', cdpFailure);
    session.cdp.socket.once('error', cdpFailure);
    session.styles.on('failure', error => { report.errors.push(`Stylesheet reapplication: ${error.message}`); requestStop('stylesheet-error'); });
    report.processIdentity = await getProcessIdentity(child.pid);
    if (report.processIdentity?.executable !== executable || report.processIdentity.uid !== process.getuid()) {
      throw new Error('The launched fixture process did not match the expected executable and user.');
    }
    report.activeInventory = await fixtureApplicationInventory();
    const registered = report.activeInventory.applications;
    if (registered.length !== 1 || registered[0].pid !== child.pid ||
        await realpath(registered[0].bundlePath) !== await realpath(bundle)) {
      throw new Error('The launched Style Lab instance is not exclusive.');
    }
    report.activeProcessIdentity = await getProcessIdentity(child.pid);
    if (!sameProcessIdentity(report.processIdentity, report.activeProcessIdentity)) {
      throw new Error('The launched fixture process identity changed during its application registry check.');
    }
    status = { ...status, pid: child.pid, port: session.port, processIdentity: report.processIdentity };
    if (!stopReason) await applySelection(selection);
    while (!stopReason) {
      let timer;
      await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, 750); }), stopping]);
      clearTimeout(timer);
      if (!stopReason) {
        await applySelection(await readFixtureExtensionLibrary(options.library));
        if (!stopReason && pendingJSReapplication) {
          const update = pendingJSReapplication;
          pendingJSReapplication = null;
          report.latestJSReapplication = update;
          if (activeRevision) activeRevision.latestJSReapplication = update;
          // Keep all file publishing on the broker loop, rather than racing an
          // event callback against the current library revision's writes.
          await publish(update);
        }
        await heartbeat();
      }
    }
  } catch (error) {
    report.errors.push(error.message);
    requestStop('error');
  } finally { await cleanup(); }
  if (report.errors.length) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = argumentsFrom(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
  if (options) runDockFixture(options).catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}
