// Fixed Figma login-screen proof. Standard CDP pipe, cosmetic CSS only.
// Does not drive DevTools, evaluate JavaScript, or modify the signed bundle.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipeCDP } from '../lib/pipe-cdp.mjs';
import { CosmeticTrial } from '../lib/cosmetic-trial.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';

if (process.argv.length !== 2) throw new Error('Usage: node scripts/verify-figma-pipe.mjs');
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bundle = '/Applications/Figma.app';
const executable = `${bundle}/Contents/MacOS/Figma`;
const selector = 'button[type="submit"]';
const stamp = new Date().toISOString().replaceAll(':', '-');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'output/compatibility/figma/pipe', stamp);
const report = {
  startedAt: new Date().toISOString(), bundle, selector,
  control: 'Log in with browser', mode: 'external-cdp-pipe',
  status: 'starting', verdict: 'incomplete', cssPass: false,
  computerUseRequired: false, arbitraryJavaScript: false,
  errors: [],
};
let child, profile, pipe, page, sessionId, trial;
let interrupted = false;
const recordError = (phase, error) => report.errors.push({ phase, message: String(error.message ?? error).slice(0, 1000) });
const checkInterrupted = () => { if (interrupted) throw new Error('Verification interrupted.'); };
const onSignal = () => { interrupted = true; pipe?.close(); };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

async function requireNoFigma() {
  try {
    const { stdout } = await exec('/usr/bin/pgrep', ['-f', '^/.*/Figma\\.app/Contents/MacOS/Figma( |$)']);
    if (stdout.trim()) throw new Error('Figma is already running. Quit it normally before this launch-time pipe proof.');
  } catch (error) {
    if (error.code !== 1) throw error;
  }
}

async function requireOwner() {
  checkInterrupted();
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Owned Figma process is no longer running.');
  const { stdout } = await exec('/bin/ps', ['-p', String(child.pid), '-o', 'comm=']);
  if (stdout.trim() !== executable) throw new Error('Owned process does not match the installed Figma executable.');
}

function isLoginPage(target) {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    return url.protocol === 'https:' && ['www.figma.com', 'figma.com'].includes(url.hostname) && /^\/login\/?$/.test(url.pathname);
  } catch { return false; }
}

async function loginTarget() {
  const deadline = Date.now() + 20000;
  do {
    await requireOwner();
    const { targetInfos } = await pipe.call('Target.getTargets');
    const matches = targetInfos.filter(isLoginPage);
    if (matches.length > 1) throw new Error('More than one Figma login page; refusing an ambiguous target.');
    if (matches.length === 1) return matches[0].targetId;
    if (Date.now() >= deadline) throw new Error('No unique Figma login page appeared within 20 seconds.');
    await delay(200);
  } while (true);
}

async function capture(name) {
  await requireLoginTarget();
  const { root: document } = await page.call('DOM.getDocument', { depth: 0 });
  const { nodeIds } = await page.call('DOM.querySelectorAll', { nodeId: document.nodeId, selector });
  if (nodeIds.length !== 1) throw new Error('Screenshot requires one login button.');
  const { model } = await page.call('DOM.getBoxModel', { nodeId: nodeIds[0] });
  const x = Math.min(...model.border.filter((_, i) => i % 2 === 0));
  const y = Math.min(...model.border.filter((_, i) => i % 2 === 1));
  if (![x, y, model.width, model.height].every(Number.isFinite) || x < 0 || y < 0 || model.width <= 0 || model.height <= 0) throw new Error('Invalid control screenshot bounds.');
  const { data } = await page.call('Page.captureScreenshot', {
    format: 'png', clip: { x, y, width: model.width, height: model.height, scale: 1 }
  });
  await writeFile(path.join(folder, `${name}.png`), Buffer.from(data, 'base64'));
}

async function requireLoginTarget() {
  await requireOwner();
  const { targetInfos } = await pipe.call('Target.getTargets');
  const target = targetInfos.find(item => item.targetId === report.target?.id);
  if (!target || !isLoginPage(target)) throw new Error('Selected Figma target left the login page.');
}

async function stopOwnedChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    let forceTimer, deadline;
    const finish = exited => {
      clearTimeout(forceTimer); clearTimeout(deadline);
      child.off('exit', onExit); resolve(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    forceTimer = setTimeout(() => { report.forcedOwnedChildStop = true; child.kill('SIGKILL'); }, 3000);
    deadline = setTimeout(() => finish(false), 6000);
    child.kill('SIGTERM');
  });
}

await mkdir(folder, { recursive: true });
try {
  await requireNoFigma();
  report.before = await inspectIntegrity(bundle);
  checkInterrupted();
  profile = await mkdtemp(path.join(tmpdir(), 'extensions-anywhere-figma-css-pipe-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  checkInterrupted();
  child = spawn(executable, ['--remote-debugging-pipe', `--user-data-dir=${profile}`], {
    env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
  });
  report.launch = { pid: child.pid, flags: ['--remote-debugging-pipe', '--user-data-dir=<temporary>'], profileIsolationGuaranteed: false };
  child.on('error', error => { recordError('launch', error); pipe?.close(); });
  child.stderr.on('data', chunk => { report.stderrBytes = (report.stderrBytes ?? 0) + chunk.length; });
  pipe = new PipeCDP(child.stdio[4], child.stdio[3]);
  report.browser = await pipe.call('Browser.getVersion');
  const targetId = await loginTarget();
  report.target = { id: targetId, type: 'page', route: 'https://www.figma.com/login (query omitted)' };
  ({ sessionId } = await pipe.call('Target.attachToTarget', { targetId, flatten: true }));
  page = { call: (method, params) => pipe.call(method, params, sessionId) };
  trial = new CosmeticTrial(page, selector);
  // The page target can exist before its login markup has rendered.
  const readyDeadline = Date.now() + 15000;
  while (true) {
    await requireLoginTarget();
    try { report.original = await trial.init(); break; }
    catch (error) { if (Date.now() >= readyDeadline) throw error; await delay(200); }
  }
  await capture('before');
  await requireLoginTarget();
  report.css = await trial.apply();
  await requireLoginTarget();
  if (!report.css.matchesExpected) throw new Error('Programmatic CSS did not produce the expected computed colors.');
  await capture('green');
  report.active = await inspectIntegrity(bundle);
  report.activeUnchanged = compareIntegrity(report.before, report.active).unchanged;
  await requireOwner();
  report.css = { ...report.css, ...(await trial.remove()) };
  if (!report.css.matchesOriginal) throw new Error('Programmatic stylesheet removal did not restore the original appearance.');
  await capture('restored');
  report.status = 'complete';
} catch (error) {
  report.status = 'failed'; recordError('verification', error);
} finally {
  if (trial) {
    try { await trial.dispose(); } catch (error) { recordError('stylesheet-cleanup', error); }
  }
  if (sessionId && pipe) {
    try { await pipe.call('Target.detachFromTarget', { sessionId }); } catch (error) { recordError('detach', error); }
  }
  pipe?.close();
  const exited = await stopOwnedChild();
  report.processExited = exited;
  if (child) report.launch = { ...report.launch, exitCode: child.exitCode, signal: child.signalCode };
  if (!exited) recordError('process-cleanup', new Error('Owned child did not exit; temporary profile retained.'));
  if (profile && exited) {
    try { await rm(profile, { recursive: true, force: true }); report.temporaryProfileRemoved = true; }
    catch (error) { recordError('profile-cleanup', error); }
  }
  if (report.before) {
    try {
      report.after = await inspectIntegrity(bundle);
      report.unchanged = compareIntegrity(report.before, report.after).unchanged;
    } catch (error) { recordError('final-integrity', error); }
  }
  report.cssPass = report.css?.matchesExpected === true && report.css?.matchesOriginal === true &&
    report.activeUnchanged === true && report.unchanged === true && report.status === 'complete' && !report.errors.length;
  report.verdict = report.cssPass ? 'pass' : 'incomplete';
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  console.log(JSON.stringify({ report: path.join(folder, 'report.json'), verdict: report.verdict, css: report.css, unchanged: report.unchanged, errors: report.errors }));
  process.exitCode = report.cssPass ? 0 : 1;
}
