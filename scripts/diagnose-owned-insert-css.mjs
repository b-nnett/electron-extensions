// Isolated owned fixture: no vendor app, external page, debugger, or user profile.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fingerprint, signature } from '../lib/integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'output/owned-insert-css', new Date().toISOString().replaceAll(':', '-'));
const runtime = path.join(root, 'node_modules/electron/dist/Electron.app');
async function runtimeIntegrity() {
  const contents = await fingerprint(runtime);
  try { return { ...contents, ...(await signature(runtime)) }; }
  catch { return { ...contents, valid: false, signatureObservation: 'Existing npm Electron runtime fails strict signature verification; no signing changes made.' }; }
}
const profile = await mkdtemp(path.join(tmpdir(), 'extensions-anywhere-owned-css-'));
await mkdir(folder, { recursive: true });
const main = String.raw`
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setName('Owned CSS Removal Diagnostic');
app.setPath('userData', process.env.OWNED_CSS_PROFILE);
const folder = process.env.OWNED_CSS_OUTPUT;
const report = { versions: process.versions, pid: process.pid, scope: 'owned fixture only', trials: [], errors: [] };
const html = '<!doctype html><meta charset="utf-8"><title>Owned CSS Removal Diagnostic</title><style>body{margin:40px;background:white}button{width:220px;height:48px;border:0;border-radius:8px;background:rgb(37,99,235);color:rgb(255,255,255);font:16px system-ui}</style><button id="probe">Owned style probe</button>';
const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
const css = '#probe {background-color:rgb(22,163,74) !important;color:rgb(255,255,255) !important;background-image:none !important;}';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const snap = wc => wc.executeJavaScript('(()=>{const b=document.querySelector("#probe"),c=getComputedStyle(b),r=b.getBoundingClientRect();return {background:c.backgroundColor,color:c.color,backgroundImage:c.backgroundImage,box:{x:r.x,y:r.y,width:r.width,height:r.height}}})()', false);
async function capture(wc, name, state) {
  await Promise.race([wc.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', false), wait(250)]);
  const image = await wc.capturePage(state.box);
  fs.writeFileSync(path.join(folder, name + '.png'), image.toPNG());
  return name + '.png';
}
let win;
const watchdog = setTimeout(() => { report.errors.push('Owned fixture exceeded 30 seconds'); save(); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win = new BrowserWindow({ width: 420, height: 220, title: 'Owned CSS Removal Diagnostic', show: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const origin of ['user', 'author-default']) {
      await wc.loadURL(url);
      await wait(750);
      const trial = { origin, before: await snap(wc), captures: {} };
      report.trials.push(trial);
      trial.captures.before = await capture(wc, origin + '-before', trial.before);
      trial.key = origin === 'user' ? await wc.insertCSS(css, { cssOrigin: 'user' }) : await wc.insertCSS(css);
      await wait(250);
      trial.applied = await snap(wc);
      trial.captures.applied = await capture(wc, origin + '-applied', trial.applied);
      await wc.removeInsertedCSS(trial.key);
      trial.removalPromiseResolved = true;
      await wait(1500);
      trial.removed = await snap(wc);
      trial.captures.removed = await capture(wc, origin + '-removed', trial.removed);
      trial.applicationMatches = trial.applied.background === 'rgb(22, 163, 74)';
      trial.removalMatches = trial.removed.background === trial.before.background;
      if (!trial.removalMatches) {
        await wait(1500);
        await wc.removeInsertedCSS(trial.key);
        trial.repeatedRemoval = await snap(wc);
        await wc.loadURL(url);
        await wait(250);
        trial.reloaded = await snap(wc);
        trial.captures.reloaded = await capture(wc, origin + '-reloaded', trial.reloaded);
      }
      save();
    }
  } catch (error) { report.errors.push(String(error.stack || error)); }
  finally {
    save(); clearTimeout(watchdog);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
`;
await writeFile(path.join(folder, 'main.cjs'), main);
const before = await runtimeIntegrity();
const env = { ...process.env, OWNED_CSS_PROFILE: profile, OWNED_CSS_OUTPUT: folder };
delete env.ELECTRON_RUN_AS_NODE;
let child;
const cleanup = { ownedRuntime: runtime, before };
try {
  child = spawn(path.join(runtime, 'Contents/MacOS/Electron'), [path.join(folder, 'main.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', bytes => { cleanup.stderrBytes = (cleanup.stderrBytes || 0) + bytes.length; });
  cleanup.pid = child.pid;
  const result = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGTERM'); }, 40000);
    const force = setTimeout(() => { child.kill('SIGKILL'); }, 44000);
    child.once('error', error => { clearTimeout(deadline); clearTimeout(force); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(deadline); clearTimeout(force); resolve({ code, signal }); });
  });
  cleanup.exit = result;
} finally {
  cleanup.after = await runtimeIntegrity();
  cleanup.unchanged = before.sha256 === cleanup.after.sha256 && before.valid === cleanup.after.valid;
  cleanup.processExited = child?.exitCode !== null || child?.signalCode !== null;
  if (cleanup.processExited) { await rm(profile, { recursive: true, force: true }); cleanup.profileRemoved = true; }
  await writeFile(path.join(folder, 'integrity-cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n');
}
const report = JSON.parse(await readFile(path.join(folder, 'report.json'), 'utf8'));
console.log(JSON.stringify({ folder, electron: report.versions.electron, chromium: report.versions.chrome,
  trials: report.trials.map(t => ({ origin: t.origin, before: t.before.background, applied: t.applied.background, removed: t.removed.background,
    removalPromiseResolved: t.removalPromiseResolved, removalMatches: t.removalMatches, repeatedRemoval: t.repeatedRemoval?.background, reloaded: t.reloaded?.background })),
  errors: report.errors, integrityUnchanged: cleanup.unchanged, processExited: cleanup.processExited, profileRemoved: cleanup.profileRemoved }));
process.exitCode = report.errors.length ? 1 : 0;
