import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const journal = path.join(os.homedir(), 'Library/Application Support/Extensions Anywhere/runtime-events.json');
const quote = value => JSON.stringify(value);
const apple = async script => (await exec('/usr/bin/osascript', ['-e', script], { timeout: 15000, maxBuffer: 128 * 1024 })).stdout.trim();

export function restartAlertGeometry(values) {
  if (!Array.isArray(values) || values.length !== 4 || !values.every(Number.isFinite)) throw new Error('Invalid restart alert geometry.');
  const [x, y, width, height] = values;
  if (Math.abs(x) > 131072 || Math.abs(y) > 131072 || width < 100 || height < 80 || width > 4096 || height > 4096 || width * height > 8 * 1024 * 1024) {
    throw new Error('Restart alert geometry exceeds capture bounds.');
  }
  return [Math.floor(x), Math.floor(y), Math.ceil(x + width) - Math.floor(x), Math.ceil(y + height) - Math.floor(y)];
}

// Pure matcher is shared by Node validation and the fresh JXA snapshot before
// clicking. A malformed matching alert must not be skipped in favor of another.
export function selectRestartAlert(snapshot, promptText) {
  if (!snapshot || !Number.isSafeInteger(snapshot.ownerPID) || snapshot.ownerPID <= 0 || !Array.isArray(snapshot.windows) || snapshot.windows.length > 12) {
    throw new Error('Expected one identifiable manager accessibility process.');
  }
  const suffix = ' is running without extensions.';
  if (typeof promptText !== 'string' || !promptText.endsWith(suffix) || promptText.length <= suffix.length) throw new Error('Invalid expected restart prompt text.');
  const informativeText = `${promptText.slice(0, -suffix.length)} will quit normally, then reopen with your enabled extensions.`;
  const normalize = text => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  // NSAlert may expose messageText and informativeText as one AXStaticText.
  const allowedText = [normalize(promptText), normalize(`${promptText} ${informativeText}`)];
  const matches = snapshot.windows.filter(window => [window.title].concat(Array.isArray(window.texts) ? window.texts : []).some(text => allowedText.includes(normalize(text))));
  if (matches.length !== 1) throw new Error('Expected exactly one app-specific native restart alert.');
  const window = matches[0];
  if (window.complete !== true || !['AXWindow', 'AXDialog'].includes(window.role) || !Number.isSafeInteger(window.index) || window.index < 1 || window.index > 12) {
    throw new Error('Restart alert accessibility snapshot is incomplete.');
  }
  const geometry = restartAlertGeometry(window.geometry);
  if (!Array.isArray(window.buttons) || window.buttons.length !== 2) throw new Error('Unexpected native restart alert controls.');
  const named = name => window.buttons.filter(button => button.name === name);
  const restart = named('Restart'), cancel = named('Not Now');
  if (restart.length !== 1 || cancel.length !== 1) throw new Error('Native restart alert button names are ambiguous.');
  for (const button of window.buttons) {
    if (button.enabled !== true || !Array.isArray(button.path) || button.path.length < 1 || button.path.length > 8 || !button.path.every(index => Number.isSafeInteger(index) && index >= 0 && index < 256)) {
      throw new Error('Native restart alert button is disabled or unidentifiable.');
    }
    const b = button.geometry;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= 0 || b[3] <= 0 ||
        b[0] < window.geometry[0] - 1 || b[1] < window.geometry[1] - 1 ||
        b[0] + b[2] > window.geometry[0] + window.geometry[2] + 1 || b[1] + b[3] > window.geometry[1] + window.geometry[3] + 1) {
      throw new Error('Native restart alert button lies outside its window.');
    }
  }
  if (JSON.stringify(restart[0].path) === JSON.stringify(cancel[0].path)) throw new Error('Native restart alert controls share an accessibility path.');
  return { ownerPID: snapshot.ownerPID, ownerBundleIdentifier: snapshot.ownerBundleIdentifier, windowIndex: window.index,
    title: window.title, role: window.role, subrole: window.subrole, promptText, geometry,
    restart: restart[0], cancel: cancel[0] };
}

export function revalidateRestartAlert(previous, current) {
  if (JSON.stringify(previous) !== JSON.stringify(current)) throw new Error('Expected app-specific native alert changed before click.');
  return current;
}

export function pendingRestartPrompt(events, profile, pid, previous) {
  const matching = events.filter(event => event.appKey === profile.bundleIdentifier && event.bundlePath === profile.bundlePath);
  const presentations = matching.filter(event => event.event === 'promptPresented').sort((a, b) => a.timestamp - b.timestamp);
  const presented = presentations[presentations.length - 1];
  if (!presented) return null;
  if (presented.processIdentifier !== pid || !Number.isFinite(presented.timestamp) || !Number.isFinite(presented.processStartedAt)) {
    throw new Error('Restart prompt journal does not identify the expected process instance.');
  }
  if (previous && (presented.timestamp !== previous.timestamp || presented.processStartedAt !== previous.processStartedAt)) {
    throw new Error('Restart prompt instance changed before click.');
  }
  if (matching.some(event => ['restartAccepted', 'restartDeclined'].includes(event.event) && event.timestamp >= presented.timestamp &&
      event.processIdentifier === pid && event.processStartedAt === presented.processStartedAt)) {
    throw new Error('The expected restart prompt has already been answered.');
  }
  return presented;
}

function restartAlertScript(promptText, previous = null) {
  return `
  ${restartAlertGeometry.toString()}
  ${selectRestartAlert.toString()}
  ${revalidateRestartAlert.toString()}
  const se = Application('System Events');
  const managers = se.applicationProcesses.whose({name: 'ExtensionsAnywhere'})();
  if (managers.length !== 1) throw new Error('Expected one manager accessibility process');
  const manager = managers[0];
  const windows = manager.windows();
  if (windows.length > 12) throw new Error('Too many manager windows for bounded alert inspection');
  const read = function(operation, fallback) { try { return operation(); } catch (_) { return fallback; } };
  const snapshot = {ownerPID: manager.unixId(), ownerBundleIdentifier: manager.bundleIdentifier(), windows: []};
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const result = {index: i + 1, title: read(function() { return w.name(); }, ''), role: read(function() { return w.role(); }, ''),
      subrole: read(function() { return w.subrole(); }, ''), geometry: read(function() { return w.position().concat(w.size()); }, null),
      texts: [], buttons: [], complete: true};
    const pending = [{element: w, path: []}];
    let count = 0;
    while (pending.length) {
      if (++count > 256) { result.complete = false; break; }
      const item = pending.shift(), element = item.element;
      const role = read(function() { return element.role(); }, '');
      if (role === 'AXStaticText') {
        for (const text of [read(function() { return element.name(); }, ''), read(function() { return element.value(); }, '')]) {
          if (typeof text === 'string' && text.length <= 4096) result.texts.push(text);
        }
      }
      if (role === 'AXButton') result.buttons.push({name: read(function() { return element.name(); }, ''),
        enabled: read(function() { return element.enabled(); }, false), path: item.path,
        geometry: read(function() { return element.position().concat(element.size()); }, null)});
      const children = read(function() { return element.uiElements(); }, null);
      if (children === null || children.length > 256 || (item.path.length >= 8 && children.length)) { result.complete = false; break; }
      for (let j = 0; j < children.length; j++) pending.push({element: children[j], path: item.path.concat(j)});
      if (pending.length + count > 256) { result.complete = false; break; }
    }
    snapshot.windows.push(result);
  }
  const selected = selectRestartAlert(snapshot, ${quote(promptText)});
  const previous = ${quote(previous)};
  if (previous !== null) {
    revalidateRestartAlert(previous, selected);
    let button = windows[selected.windowIndex - 1];
    for (const index of selected.restart.path) button = button.uiElements()[index];
    if (button.role() !== 'AXButton' || button.name() !== 'Restart' || button.enabled() !== true) throw new Error('Named Restart control changed before click');
    se.click(button);
  }
  JSON.stringify(selected);
  `;
}

async function inspectRestartAlert(promptText, previous = null) {
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', restartAlertScript(promptText, previous)], { timeout: 15000, maxBuffer: 128 * 1024 });
  return JSON.parse(stdout.trim());
}

export async function requirePNG(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size < 24 || stat.size > 32 * 1024 * 1024) throw new Error('Required screenshot is missing, empty, or invalid.');
  const bytes = await readFile(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) throw new Error('Required screenshot is not a PNG with nonzero dimensions.');
  return file;
}

export async function eventsFor(profile, since = 0) {
  let events;
  try { events = JSON.parse(await readFile(journal, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return events.filter(event => event.appKey === profile.bundleIdentifier && event.bundlePath === profile.bundlePath &&
    (event.timestamp + 978307200) * 1000 >= since).map(event => ({ ...event, at: new Date((event.timestamp + 978307200) * 1000).toISOString() }));
}

export async function saveEvents(profile, file, since = 0) {
  const events = await eventsFor(profile, since);
  await writeFile(file, JSON.stringify(events, null, 2) + '\n', { mode: 0o600 });
  return events;
}

export async function launchFromMenu(profile, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const startedAt = Date.now();
  let layout, numbers;
  for (let attempt = 0; attempt < 3 && !numbers; attempt++) {
    layout = await apple(`tell application "System Events"
    tell process "ExtensionsAnywhere"
      click menu bar item "Jigsaw Piece Extension" of menu bar 2
      set m to menu 1 of menu bar item "Jigsaw Piece Extension" of menu bar 2
      set itemNames to name of every menu item of m
      set geometry to {position of m, size of m}
      return {itemNames, geometry}
    end tell
  end tell`);
    await writeFile(path.join(outputDirectory, `menu-layout-${attempt + 1}.txt`), layout + '\n');
  // Read/capture/click occur within this operation, without a tool boundary
  // returning focus to another app in between.
    for (let sample = 0; sample < 10; sample++) {
      await delay(100);
      const geometry = await apple(`tell application "System Events"
    tell process "ExtensionsAnywhere"
      get {position, size} of menu 1 of menu bar item "Jigsaw Piece Extension" of menu bar 2
    end tell
  end tell`);
      const values = geometry.match(/-?\d+/g)?.map(Number);
      if (values?.length === 4 && values[2] > 0 && values[3] > 0) { numbers = values; break; }
    }
  }
  await writeFile(path.join(outputDirectory, 'menu-layout.txt'), layout + '\n');
  if (numbers?.length !== 4 || numbers[2] <= 0 || numbers[3] <= 0) throw new Error('Required menu screenshot has invalid geometry.');
  await exec('/usr/sbin/screencapture', ['-x', '-t', 'png', '-R' + numbers.join(','), path.join(outputDirectory, 'menu.png')]);
  const screenshot = await requirePNG(path.join(outputDirectory, 'menu.png'));
  await apple(`tell application "System Events"
    tell process "ExtensionsAnywhere"
      set m to menu 1 of menu bar item "Jigsaw Piece Extension" of menu bar 2
      if exists menu item "All Tweaked Apps" of m then
        click menu item "All Tweaked Apps" of m
        click menu item ${quote(profile.name)} of menu 1 of menu item "All Tweaked Apps" of m
      else
        click menu item ${quote(profile.name)} of m
      end if
    end tell
  end tell`);
  for (let i = 0; i < 20; i++) {
    const events = await eventsFor(profile, startedAt);
    if (events.some(event => event.event === 'menuLaunchRequested')) {
      await saveEvents(profile, path.join(outputDirectory, 'menu-events.json'), startedAt);
      return { startedAt: new Date(startedAt).toISOString(), layout, screenshot, requested: true };
    }
    await delay(250);
  }
  throw new Error('Menu click did not produce the native menu launch event.');
}

export async function acceptRestartPrompt(profile, pid, outputDirectory, { since = Date.now(), timeoutMs = 95000 } = {}) {
  await mkdir(outputDirectory, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let presented;
  while (Date.now() < deadline) {
    presented = pendingRestartPrompt(await eventsFor(profile, since), profile, pid);
    if (presented) break;
    await delay(500);
  }
  if (!presented) throw new Error('The native restart prompt did not appear for the expected normal process.');
  const promptText = `${profile.name} is running without extensions.`;
  const alert = await inspectRestartAlert(promptText);
  const numbers = alert.geometry;
  await exec('/usr/sbin/screencapture', ['-x', '-t', 'png', '-R' + numbers.join(','), path.join(outputDirectory, 'restart-prompt.png')]);
  await requirePNG(path.join(outputDirectory, 'restart-prompt.png'));
  await writeFile(path.join(outputDirectory, 'restart-prompt-ui.json'), JSON.stringify({ promptText, buttons: ['Not Now', 'Restart'], geometry: numbers, presented, alert }, null, 2) + '\n');
  if (!pendingRestartPrompt(await eventsFor(profile, since), profile, pid, presented)) throw new Error('Expected restart prompt journal disappeared before click.');
  const clickedAt = new Date().toISOString();
  await inspectRestartAlert(promptText, alert);
  for (let i = 0; i < 20; i++) {
    const events = await eventsFor(profile, Date.parse(clickedAt));
    if (events.some(event => event.event === 'restartAccepted' && event.processIdentifier === pid && event.processStartedAt === presented.processStartedAt)) {
      await saveEvents(profile, path.join(outputDirectory, 'restart-events.json'), since);
      return { presented, accepted: true, clickedAt };
    }
    await delay(250);
  }
  throw new Error('The prompt click did not produce a native restart acceptance event.');
}
