// Supervised E2E primitives. Importing this module performs no app actions.
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { waitForNormalExit } from './wait-normal-exit.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../../lib/process-identity.mjs';
import { readBoundedJSON, validateCatalogProfile } from '../../lib/catalog-stylesheet.mjs';

const run = promisify(execFile);
export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const fixedInventory = path.join(repositoryRoot, 'output/e2e-50/2026-09-08/inventory-2026-09-08T18-54-05.377Z/inventory.json');
const windowHelper = path.join(repositoryRoot, 'output/e2e-50/2026-09-08/helpers/window-inventory');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPID = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const fail = (message, result) => Object.assign(new Error(message), result === undefined ? {} : { result });

export async function requireUnlockedDesktop() {
  const source = `import CoreGraphics
import Foundation
guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { exit(1) }
let state: [String: Bool] = ["locked": (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false,
 "onConsole": (session["kCGSSessionOnConsoleKey"] as? NSNumber)?.boolValue ?? false,
 "loginDone": (session["kCGSessionLoginDoneKey"] as? NSNumber)?.boolValue ?? false]
print(String(decoding: try JSONSerialization.data(withJSONObject: state), as: UTF8.self))`;
  const { stdout } = await run('/usr/bin/swift', ['-e', source], { timeout: 15000, maxBuffer: 16384 });
  const state = JSON.parse(stdout);
  if (state.locked !== false || state.onConsole !== true || state.loginDone !== true) {
    throw fail('An unlocked logged-in console session is required for native E2E screenshots and UI actions.', state);
  }
  return state;
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\0\r\n]/.test(value)) {
    throw new Error('Expected a normalized absolute path.');
  }
  return value;
}

async function profiles() {
  const catalog = await readBoundedJSON(path.join(repositoryRoot, 'compatibility/runtime-profiles.json'), 256 * 1024);
  if (!Array.isArray(catalog) || catalog.length > 64) throw new Error('Invalid fixed runtime catalog.');
  const entries = catalog.map(value => ({ ...validateCatalogProfile(value), runtimeSupported: true }));
  const inventory = await readBoundedJSON(fixedInventory, 4 * 1024 * 1024);
  const cohort = await readBoundedJSON(path.join(repositoryRoot, 'compatibility/apps.json'), 1024 * 1024);
  if (!Array.isArray(inventory.rows) || !Array.isArray(cohort)) throw new Error('Invalid fixed inventory.');
  for (const item of cohort) {
    if (entries.some(entry => entry.slug === item.slug)) continue;
    const observed = inventory.rows.find(row => row.slug === item.slug)?.installed;
    if (!observed?.bundleIdentifier || !observed?.executablePath || observed.canonicalPath !== item.bundlePath) continue;
    entries.push({ slug: item.slug, name: item.name, bundlePath: item.bundlePath,
      bundleIdentifier: observed.bundleIdentifier, executable: observed.executablePath,
      transport: null, arguments: [], target: null, runtimeSupported: false });
  }
  entries.push({ slug: 'chatgpt', name: 'ChatGPT', bundlePath: '/Applications/ChatGPT.app',
    bundleIdentifier: 'com.openai.codex', executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    transport: 'tcp', runtimeSupported: true });
  entries.push({ slug: 'stylelab', name: 'Style Lab', bundlePath: '/Applications/Style Lab.app',
    bundleIdentifier: 'dev.extensionsanywhere.stylelab', executable: '/Applications/Style Lab.app/Contents/MacOS/Style Lab',
    transport: 'tcp', runtimeSupported: true });
  if (new Set(entries.map(entry => entry.slug)).size !== entries.length) throw new Error('Duplicate fixed profile slug.');
  return entries;
}

/** Excluded runtime apps have an inventory identity for ordinary launch/quit only. */
export async function profileFor(slug) {
  const profile = (await profiles()).find(entry => entry.slug === slug);
  if (!profile) throw new Error(`No fixed installed identity for app slug ${String(slug)}.`);
  return profile;
}

async function fixedProfile(value, runtime = false) {
  const profile = await profileFor(typeof value === 'string' ? value : value?.slug);
  if (typeof value !== 'string' && ['bundlePath', 'bundleIdentifier', 'executable'].some(key => value[key] !== profile[key])) {
    throw new Error('Supplied profile does not match its fixed catalog identity.');
  }
  if (runtime && !profile.runtimeSupported) throw new Error(`${profile.name} has no integrated runtime route.`);
  return profile;
}

async function installedIdentity(profile) {
  if (await realpath(profile.bundlePath) !== profile.bundlePath || await realpath(profile.executable) !== profile.executable) {
    throw new Error('The installed app or executable is no longer at its fixed canonical path.');
  }
  const info = path.join(profile.bundlePath, 'Contents/Info.plist');
  const read = key => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', info], { timeout: 5000, maxBuffer: 16384 });
  const [identifier, executable] = await Promise.all([read('CFBundleIdentifier'), read('CFBundleExecutable')]);
  if (identifier.stdout.trim() !== profile.bundleIdentifier || executable.stdout.trim() !== path.basename(profile.executable)) {
    throw new Error('The installed app identity changed.');
  }
}

async function newOutput(value, extension) {
  const file = absolute(value);
  if (!file.endsWith(extension) || file.split(path.sep).some(part => part.toLowerCase().endsWith('.app'))) {
    throw new Error(`Output must be a new ${extension} file outside application bundles.`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  if (await realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('Output parent must be canonical.');
  try { await access(file); } catch (error) { if (error.code === 'ENOENT') return file; throw error; }
  throw new Error(`Output already exists: ${file}`);
}

/** A passed harness action is not evidence of CSS, prompt, menu, or signing success. */
export async function harness(action, slug, outputPath, recordID) {
  await fixedProfile(slug, true);
  if (!['add', 'open', 'disable', 'enable', 'remove', 'inspect', 'prepare-voice', 'restore-voice'].includes(action)) throw new Error('Unknown harness action.');
  if (['prepare-voice', 'restore-voice'].includes(action) && (slug !== 'chatgpt' || recordID !== '8C12BB85-B94C-4FDE-8517-16A0470A6FAD')) throw new Error('Voice preference preparation is limited to the exact original ChatGPT record.');
  if (recordID !== undefined && !uuid.test(recordID)) throw new Error('recordID must be the exact UUID returned by add.');
  if (action === 'add' && recordID !== undefined) throw new Error('Add generates its own record ID.');
  if (['open', 'disable', 'enable', 'remove'].includes(action) && !recordID) throw new Error('This action requires its owned record ID.');
  const output = await newOutput(outputPath, '.json');
  const logPath = await newOutput(output.replace(/\.json$/, '.log'), '.log');
  const env = { ...process.env, EA_E2E_ACTION: action, EA_E2E_APP: slug, EA_E2E_OUTPUT: output };
  delete env.EA_E2E_RECORD_ID;
  if (recordID) env.EA_E2E_RECORD_ID = recordID;
  let execution, failure;
  try {
    execution = await run('/usr/bin/xcrun', ['xctest', '-XCTest',
      'ExtensionsAnywhereTests.CatalogLiveValidationTests/testOptInCatalogAction',
      path.join(repositoryRoot, 'macos/.build/arm64-apple-macosx/debug/ExtensionsAnywherePackageTests.xctest')],
      { cwd: "/", env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) { failure = error; execution = error; }
  await writeFile(logPath, `STDOUT\n${execution.stdout ?? ''}\nSTDERR\n${execution.stderr ?? ''}\nEXIT ${failure?.code ?? 0}\n`, { flag: 'wx', mode: 0o600 });
  let result;
  try { result = await readBoundedJSON(output, 1024 * 1024); }
  catch (cause) { throw Object.assign(fail('Harness did not produce a readable result.', { action, slug, output, logPath }), { cause }); }
  if (failure || result.passed !== true || result.action !== action || result.slug !== slug) {
    throw Object.assign(fail('Harness action failed; inspect the attached result and neighboring log.', result), { logPath, cause: failure });
  }
  return result;
}

/** Public registry query, returning only the selected app (conflicting identity fails closed). */
export async function registration(supplied) {
  const profile = await fixedProfile(supplied);
  const script = `ObjC.import('AppKit'); var result=[]; var apps=$.NSWorkspace.sharedWorkspace.runningApplications;
    for(var i=0;i<apps.count;i++){var a=apps.objectAtIndex(i); if(a.isTerminated)continue;
      var id=ObjC.unwrap(a.bundleIdentifier), p=ObjC.unwrap(a.bundleURL.path);
      if(id===${JSON.stringify(profile.bundleIdentifier)}||p===${JSON.stringify(profile.bundlePath)})
        result.push({pid:Number(a.processIdentifier),bundleIdentifier:id,bundlePath:p,
          executable:ObjC.unwrap(a.executableURL.path)});}
    JSON.stringify(result);`;
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000, maxBuffer: 65536 });
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length > 16 || new Set(rows.map(row => row.pid)).size !== rows.length ||
      rows.some(row => !validPID(row.pid) || row.bundleIdentifier !== profile.bundleIdentifier ||
        row.bundlePath !== profile.bundlePath || row.executable !== profile.executable)) {
    throw new Error('Selected app registry contains an unexpected identity.');
  }
  return rows;
}

function requireIdentity(identity, profile) {
  if (!identity || !sameProcessIdentity(identity, identity) || identity.executable !== profile.executable || identity.uid !== process.getuid()) {
    throw new Error('A current-user kernel PID/start/executable identity for the fixed app is required.');
  }
}

/** Normal user-approved termination only. Never kills a process or a replacement instance. */
export async function normalQuit(supplied, expectedIdentity) {
  const profile = await fixedProfile(supplied);
  requireIdentity(expectedIdentity, profile);
  const rows = await registration(profile);
  if (rows.length !== 1 || rows[0].pid !== expectedIdentity.pid) throw new Error('The expected app is not the sole registered instance.');
  const current = await getProcessIdentity(expectedIdentity.pid);
  if (!sameProcessIdentity(current, expectedIdentity)) throw new Error('App process identity changed before normal quit.');
  // Kernel read immediately precedes the exact NSRunningApplication action.
  // As with AppKit termination generally, lookup and terminate are not atomic.
  const script = `ObjC.import('AppKit'); var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${expectedIdentity.pid});
    if(!a||a.isTerminated||ObjC.unwrap(a.bundleIdentifier)!==${JSON.stringify(profile.bundleIdentifier)}||
      ObjC.unwrap(a.bundleURL.path)!==${JSON.stringify(profile.bundlePath)}||
      ObjC.unwrap(a.executableURL.path)!==${JSON.stringify(profile.executable)})throw Error('App identity changed');
    JSON.stringify({accepted:Boolean(a.terminate)});`;
  const startedAt = Date.now();
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000, maxBuffer: 16384 });
  if (JSON.parse(stdout).accepted !== true) throw new Error('App declined normal termination; no force was attempted.');
  return waitForNormalExit({ identity: expectedIdentity, readIdentity: getProcessIdentity,
    readRegistration: () => registration(profile), deadline: startedAt + 30000 });
}

/** Ordinary launch only; no debug switches, profile overrides, or automatic restart. */
export async function normalOpen(supplied) {
  const profile = await fixedProfile(supplied);
  await installedIdentity(profile);
  if ((await registration(profile)).length) throw new Error('App is already running; normalOpen will not substitute or restart it.');
  const startedAt = new Date().toISOString();
  await run('/usr/bin/open', ['-a', profile.bundlePath], { timeout: 15000, maxBuffer: 16384 });
  return { requested: true, slug: profile.slug, startedAt, arguments: ['-a', profile.bundlePath] };
}

async function canonicalJSON(file, limit) {
  if (await realpath(file) !== file || !(await lstat(file)).isFile()) throw new Error('Session metadata must be a canonical regular file.');
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > limit) throw new Error('Session metadata exceeds its bound.');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
    if (bytesRead > limit) throw new Error('Session metadata grew beyond its bound.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}

export async function readSession(launcherDirectory) {
  const base = absolute(launcherDirectory);
  if (base.split(path.sep).some(part => part.toLowerCase().endsWith('.app')) || await realpath(base) !== base) {
    throw new Error('Launcher directory must be canonical and outside app bundles.');
  }
  const pointer = await canonicalJSON(path.join(base, 'latest-session.json'), 4096);
  const sessionDirectory = absolute(pointer.path);
  if (!uuid.test(path.basename(sessionDirectory)) || path.dirname(sessionDirectory) !== path.join(base, 'Sessions') ||
      await realpath(sessionDirectory) !== sessionDirectory || !(await lstat(sessionDirectory)).isDirectory()) {
    throw new Error('Latest session must be a canonical UUID directory immediately under this launcher’s Sessions.');
  }
  const status = await canonicalJSON(path.join(sessionDirectory, 'status.json'), 64 * 1024);
  const report = await canonicalJSON(path.join(sessionDirectory, 'report.json'), 16 * 1024 * 1024);
  if (!object(status) || !object(report) || typeof status.phase !== 'string') throw new Error('Invalid session status/report.');
  return { sessionDirectory, status, report };
}

/** Returns only a fresh, live, identity-checked phase; it does not assert visual proof. */
export async function waitSession(launcherDirectory, phase, options = {}) {
  const { timeoutMs = 90000, excludePID, newPID, excludeSessionDirectory } = options;
  if (!['active', 'disabled', 'starting', 'applying', 'stopped'].includes(phase) ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 90000 ||
      (excludePID !== undefined && !validPID(excludePID)) || (newPID !== undefined && !validPID(newPID))) {
    throw new Error('Invalid phase, bounded timeout, or expected PID.');
  }
  if (excludeSessionDirectory !== undefined) absolute(excludeSessionDirectory);
  const explicit = options.profile ? await fixedProfile(options.profile, true) : null;
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    try { latest = await readSession(launcherDirectory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(250); continue; }
    if (latest.sessionDirectory === excludeSessionDirectory) { latest = undefined; await delay(250); continue; }
    const { status, report } = latest;
    const inferred = (await profiles()).find(item => item.slug === (status.slug ?? report.slug) ||
      item.bundleIdentifier === (status.appKey ?? report.appKey));
    const profile = explicit ?? (inferred ? await fixedProfile(inferred, true) : null);
    if (!profile) throw fail('Session does not identify an integrated fixed profile.', latest);
    if ((status.slug && status.slug !== profile.slug) || (report.slug && report.slug !== profile.slug) ||
        (status.appKey && status.appKey !== profile.bundleIdentifier) || (report.appKey && report.appKey !== profile.bundleIdentifier) ||
        (status.bundle && status.bundle !== profile.bundlePath) || (report.bundle && report.bundle !== profile.bundlePath)) {
      throw fail('Session belongs to another app.', latest);
    }
    if (status.phase === 'error' || status.error || (Array.isArray(report.errors) && report.errors.length)) {
      throw fail('Runtime reported an error.', latest);
    }
    if (status.phase === 'stopped' && phase !== 'stopped') throw fail('Runtime stopped before the requested phase.', latest);
    if (status.phase === phase && (newPID === undefined || status.pid === newPID) &&
        (excludePID === undefined || status.pid !== excludePID)) {
      if (phase === 'stopped') return latest;
      const saved = status.processIdentity ?? report.processIdentity;
      requireIdentity(saved, profile);
      if (status.pid !== saved.pid) throw fail('Session PID and kernel identity disagree.', latest);
      const live = await getProcessIdentity(saved.pid);
      if (!sameProcessIdentity(saved, live)) throw fail('Session app process has exited or changed identity.', latest);
      const age = Date.now() - Date.parse(status.updatedAt);
      if (!Number.isFinite(age) || age < -1000 || age > 15000) throw fail('Session heartbeat is stale or invalid.', latest);
      return { ...latest, identity: live };
    }
    await delay(250);
  }
  throw fail(`Runtime did not reach ${phase} within ${timeoutMs} ms.`, latest);
}

/** Captures one selected fixed app, never emits another app’s window metadata. */
export async function captureWholeApp(pid, outputPath) {
  if (!validPID(pid)) throw new Error('A positive app PID is required.');
  const identity = await getProcessIdentity(pid);
  const profile = (await profiles()).find(item => item.executable === identity?.executable);
  if (!profile) throw new Error('Capture PID is not one of the fixed apps.');
  requireIdentity(identity, profile);
  const registered = await registration(profile);
  if (registered.length !== 1 || registered[0].pid !== pid) throw new Error('Capture app must be uniquely registered.');
  const output = await newOutput(outputPath, '.png');
  const metadataPath = await newOutput(output.replace(/\.png$/, '.json'), '.json');
  if (await realpath(windowHelper) !== windowHelper || !(await lstat(windowHelper)).isFile()) throw new Error('Fixed window inventory helper is unavailable.');
  const { stdout } = await run(windowHelper, [String(pid)], { timeout: 5000, maxBuffer: 65536 });
  const inventory = JSON.parse(stdout);
  if (inventory.pid !== pid || !Array.isArray(inventory.windows) || inventory.windows.length > 256) throw new Error('Invalid selected-app window inventory.');
  const windows = inventory.windows.map(row => {
    if (!validPID(row.id) || !object(row.bounds) || typeof row.onscreen !== 'boolean' ||
        ['X', 'Y', 'Width', 'Height'].some(key => !Number.isFinite(row.bounds[key])) || row.bounds.Width < 0 || row.bounds.Height < 0) {
      throw new Error('Invalid selected-app window bounds.');
    }
    return { id: row.id, bounds: row.bounds, onscreen: row.onscreen, layer: 0 };
  });
  const selected = windows.filter(row => row.onscreen && row.bounds.Width > 0 && row.bounds.Height > 0)
    .sort((a, b) => b.bounds.Width * b.bounds.Height - a.bounds.Width * a.bounds.Height || a.id - b.id)[0];
  const metadata = { pid, slug: profile.slug, identity, capturedAt: new Date().toISOString(), windows,
    selected: selected ?? null, scope: 'Only this PID’s layer-0 windows; largest onscreen window selected. No automatic visual acceptance.' };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (!selected) throw fail('Selected app has no onscreen layer-0 window.', metadata);
  if (!sameProcessIdentity(identity, await getProcessIdentity(pid))) throw new Error('App identity changed before capture.');
  await run('/usr/sbin/screencapture', ['-x', '-o', '-l', String(selected.id), output], { timeout: 15000, maxBuffer: 16384 });
  if (!sameProcessIdentity(identity, await getProcessIdentity(pid))) throw new Error('App identity changed during capture; image is not accepted evidence.');
  const image = await lstat(output);
  if (!image.isFile() || image.size === 0) throw new Error('Screenshot was not written.');
  return { outputPath: output, metadataPath, ...metadata };
}
