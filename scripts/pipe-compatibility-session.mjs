// Supervised, catalog-scoped cosmetic CSS trials over owned CDP pipes.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipeCDP } from '../lib/pipe-cdp.mjs';
import { CosmeticTrial } from '../lib/cosmetic-trial.mjs';
import { SessionLifecycle } from '../lib/session-lifecycle.mjs';
import { getProcessIdentity, findProcessesByExecutable, sameProcessIdentity } from '../lib/process-identity.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';

const exec = promisify(execFile);
const surfaceTypes = new Set(['page', 'webview']);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [slug, ...extra] = process.argv.slice(2);
const rancherImage = slug === 'rancher' && extra.length === 1 && extra[0] === '--rancher-image';
const rancherVolume = '/Volumes/Extensions Anywhere Rancher Proof';
const emit = value => console.log(JSON.stringify(value));
const report = { slug, startedAt: new Date().toISOString(), mode: 'external-cdp-pipe', status: 'starting', verdict: 'incomplete', errors: [] };
let bundle, executable, folder, profile, child, pipe, lines, selected, trial, ownerIdentity;
let disconnected = false, styled = false;
const recordLifecycle = (event, details = {}) => {
  report.lifecycleEvents ??= [];
  report.lifecycleEvents.push({ event, at: new Date().toISOString(), ...details });
};
const lifecycle = new SessionLifecycle({ closeInput: () => lines?.close(), closeTransport: () => pipe?.close(), record: recordLifecycle });
const onSigint = () => lifecycle.interrupt('SIGINT');
const onSigterm = () => lifecycle.interrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
const checkInterrupted = () => lifecycle.check();
const recordError = (phase, error) => {
  let message = String(error.message ?? error).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[URL omitted]');
  if (profile) message = message.split(profile).join('[temporary profile]');
  report.errors.push({ phase, message: message.slice(0, 1000) });
};
const save = () => folder ? writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n') : Promise.resolve();

async function readPlistCommand(file, args) {
  const { stdout } = await exec(file, args);
  const converted = exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-']);
  converted.child.stdin.end(stdout);
  return JSON.parse((await converted).stdout);
}

async function requireRancherImage(expectedHash) {
  const disk = await readPlistCommand('/usr/sbin/diskutil', ['info', '-plist', rancherVolume]);
  const info = await readPlistCommand('/usr/bin/hdiutil', ['info', '-plist']);
  const images = (info.images ?? []).filter(image => (image['system-entities'] ?? []).some(entity => entity['mount-point'] === rancherVolume));
  const image = images[0];
  const entity = image?.['system-entities']?.find(item => item['mount-point'] === rancherVolume);
  if (images.length !== 1 || image.writeable !== false || disk.MountPoint !== rancherVolume ||
      disk.Writable !== false || disk.WritableVolume !== false || disk.WritableMedia !== false ||
      entity['dev-entry'] !== disk.DeviceNode || await realpath(rancherVolume) !== rancherVolume || await realpath(bundle) !== bundle) {
    throw new Error('The fixed Rancher proof path must be an exact read-only disk-image mount.');
  }
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? '') || typeof image['image-path'] !== 'string') throw new Error('Rancher image requires its pinned catalog SHA-256.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(image['image-path'])) { checkInterrupted(); hash.update(chunk); }
  const imageSha256 = hash.digest('hex');
  if (imageSha256 !== expectedHash.toLowerCase()) throw new Error('Mounted Rancher image does not match the catalog SHA-256.');
  return { mode: 'read-only-disk-image', permanentlyInstalled: false, mountPoint: rancherVolume,
    imagePath: image['image-path'], imageSha256, readOnly: true, device: disk.DeviceNode };
}

function safeTarget(target) {
  let url = '(unrecognized URL)';
  try {
    const parsed = new URL(target.url);
    url = ['http:', 'https:'].includes(parsed.protocol)
      ? `${parsed.origin}/[path omitted]` : `${parsed.protocol}[path omitted]`;
  } catch {}
  return { id: target.targetId, type: target.type, url };
}

async function requireNoExistingApp() {
  const inventory = await findProcessesByExecutable(executable);
  if (inventory.matches.length) throw new Error('Selected app is already running. Quit it normally before this owned-launch pipe session.');
  if (inventory.unresolved.length) throw new Error('Process inventory is incomplete; cannot establish that the selected app is stopped.');
}

async function requireOwner() {
  checkInterrupted();
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Owned app process is no longer running.');
  const current = await getProcessIdentity(child.pid);
  if (!current || current.executable !== await realpath(executable) || current.uid !== process.getuid()) throw new Error('Owned process does not match the selected app executable.');
  if (ownerIdentity && !sameProcessIdentity(ownerIdentity, current)) throw new Error('Owned app process identity changed.');
  if (!ownerIdentity) { ownerIdentity = current; report.launch.identity = current; }
}

async function targets() {
  await requireOwner();
  const { targetInfos } = await pipe.call('Target.getTargets');
  await requireOwner();
  return targetInfos;
}

async function requireTarget(context) {
  const current = (await targets()).find(target => target.targetId === context.targetId);
  if (!current || current.type !== context.targetType || !surfaceTypes.has(current.type) || current.url !== context.rawUrl) {
    throw new Error('Selected rendered surface disappeared or changed type/URL; reselect the intended target.');
  }
}

async function attach(targetId) {
  if (typeof targetId !== 'string' || !targetId || targetId.length > 256) throw new Error('Supply an explicit page or webview targetId.');
  const target = (await targets()).find(item => item.targetId === targetId && surfaceTypes.has(item.type));
  if (!target || typeof target.url !== 'string') throw new Error('Selected page or webview is not available in the owned app.');
  const { sessionId } = await pipe.call('Target.attachToTarget', { targetId, flatten: true });
  const context = {
    targetId, sessionId, targetType: target.type, rawUrl: target.url,
    safe: { ...safeTarget(target), urlSha256: createHash('sha256').update(target.url).digest('hex') },
    page: { call: (method, params) => pipe.call(method, params, sessionId) }
  };
  try { await requireTarget(context); return context; }
  catch (error) { await pipe.call('Target.detachFromTarget', { sessionId }).catch(() => {}); throw error; }
}

async function detach(context) {
  if (context) await pipe.call('Target.detachFromTarget', { sessionId: context.sessionId });
}

async function buttons(targetId, selector = 'button,[role="button"],input[type="submit"],a') {
  const context = await attach(targetId);
  try {
    const { page } = context;
    // Reuse the CSS selector bounds without initializing or applying a trial.
    new CosmeticTrial(page, selector);
    await page.call('Page.enable');
    await page.call('DOM.enable');
    await page.call('CSS.enable');
    const { root: document } = await page.call('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await page.call('DOM.querySelectorAll', { nodeId: document.nodeId, selector });
    const { cssVisualViewport: viewport } = await page.call('Page.getLayoutMetrics');
    const candidates = [];
    const deadline = Date.now() + 30000;
    let examined = 0;
    for (const nodeId of nodeIds.slice(0, 100)) {
      checkInterrupted();
      if (Date.now() >= deadline) break;
      examined++;
      try {
        const { model } = await page.call('DOM.getBoxModel', { nodeId });
        if (!model || model.width <= 0 || model.height <= 0) continue;
        if (viewport) {
          const xs = model.border.filter((_, i) => i % 2 === 0);
          const ys = model.border.filter((_, i) => i % 2 === 1);
          if (Math.max(...xs) <= viewport.pageX || Math.min(...xs) >= viewport.pageX + viewport.clientWidth ||
              Math.max(...ys) <= viewport.pageY || Math.min(...ys) >= viewport.pageY + viewport.clientHeight) continue;
        }
        const { computedStyle } = await page.call('CSS.getComputedStyleForNode', { nodeId });
        const values = Object.fromEntries(computedStyle.map(item => [item.name, item.value]));
        if (values.display === 'none' || values.visibility === 'hidden' || Number(values.opacity) === 0) continue;
        const { node } = await page.call('DOM.describeNode', { nodeId, depth: 0 });
        const attrs = {};
        for (let i = 0; i < (node.attributes?.length ?? 0); i += 2) {
          if (['id', 'class', 'type', 'role'].includes(node.attributes[i])) attrs[node.attributes[i]] = node.attributes[i + 1].slice(0, 1000);
        }
        candidates.push({ tag: node.localName || node.nodeName, ...attrs, box: model.border });
      } catch { /* Disappearing/non-layout nodes are omitted; target identity is checked below. */ }
    }
    await requireTarget(context);
    return { target: context.safe, selector, matches: nodeIds.length, candidates, truncated: examined < nodeIds.length };
  } finally { await detach(context); }
}

async function captureControl(context, selector, name, verifyVisible = false) {
  await requireTarget(context);
  const { root: document } = await context.page.call('DOM.getDocument', { depth: 0 });
  const { nodeIds } = await context.page.call('DOM.querySelectorAll', { nodeId: document.nodeId, selector });
  if (nodeIds.length !== 1) throw new Error('Screenshot requires exactly one selected control.');
  const { model } = await context.page.call('DOM.getBoxModel', { nodeId: nodeIds[0] });
  const x = Math.min(...model.border.filter((_, i) => i % 2 === 0));
  const y = Math.min(...model.border.filter((_, i) => i % 2 === 1));
  if (![x, y, model.width, model.height].every(Number.isFinite) || x < 0 || y < 0 || model.width <= 0 || model.height <= 0) throw new Error('Invalid selected control screenshot bounds.');
  if (verifyVisible) {
    const { computedStyle } = await context.page.call('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] });
    const values = Object.fromEntries(computedStyle.map(item => [item.name, item.value]));
    const { cssVisualViewport: viewport } = await context.page.call('Page.getLayoutMetrics');
    if (values.display === 'none' || values.visibility === 'hidden' || Number(values.opacity) === 0 || !viewport ||
        x + model.width <= viewport.pageX || x >= viewport.pageX + viewport.clientWidth ||
        y + model.height <= viewport.pageY || y >= viewport.pageY + viewport.clientHeight) throw new Error('Preview control is not visibly laid out in the viewport.');
  }
  const clip = { x, y, width: model.width, height: model.height, scale: 1 };
  const { data } = await context.page.call('Page.captureScreenshot', { format: 'png', clip });
  await requireTarget(context);
  const image = `${name}.png`;
  await writeFile(path.join(folder, image), Buffer.from(data, 'base64'));
  return { image, box: { x, y, width: model.width, height: model.height } };
}

const capture = name => captureControl(selected, report.css.selector, name);

async function preview(targetId, selector) {
  if (trial) throw new Error('Preview is available only before a CSS trial is initialized.');
  const context = await attach(targetId);
  try {
    // Constructor validation only: do not initialize a CSS baseline or write CSS.
    new CosmeticTrial(context.page, selector);
    await context.page.call('Page.enable');
    await context.page.call('DOM.enable');
    await context.page.call('CSS.enable');
    const name = `preview-${(report.previews?.length ?? 0) + 1}`;
    const captured = await captureControl(context, selector, name, true);
    const result = { target: context.safe, selector, ...captured, capturedAt: new Date().toISOString() };
    report.previews = [...(report.previews ?? []), result];
    await save();
    return { ...result, path: path.join(folder, captured.image) };
  } finally { await detach(context); }
}

async function releaseTrial() {
  try { if (trial) await trial.dispose(); }
  finally {
    trial = null;
    const old = selected; selected = null; styled = false;
    await detach(old);
  }
}

async function removeTrial() {
  if (!trial) throw new Error('No CSS trial to remove.');
  await requireTarget(selected);
  const result = await trial.remove();
  styled = false;
  await requireTarget(selected);
  report.css = { ...report.css, ...result };
  await capture('restored');
  if (!result.matchesOriginal) throw new Error('CSS removal did not restore the original computed appearance.');
  return result;
}

async function stopOwnedChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    let forceTimer, deadline;
    const finish = exited => { clearTimeout(forceTimer); clearTimeout(deadline); child.off('exit', onExit); resolve(exited); };
    const onExit = (code, signal) => { recordLifecycle('owned-child-exit', { code, signal }); finish(true); };
    child.once('exit', onExit);
    forceTimer = setTimeout(() => { report.forcedOwnedChildStop = true; recordLifecycle('owned-child-signal', { signal: 'SIGKILL' }); child.kill('SIGKILL'); }, 3000);
    deadline = setTimeout(() => finish(false), 6000);
    recordLifecycle('owned-child-signal', { signal: 'SIGTERM' });
    child.kill('SIGTERM');
  });
}

async function stop() {
  if (!lifecycle.beginCleanup()) return;
  if (trial && styled) {
    try { await removeTrial(); } catch (error) { recordError('restore', error); }
  }
  try { await releaseTrial(); } catch (error) { recordError('stylesheet-cleanup', error); }
  lifecycle.closeTransport();
  const exited = await stopOwnedChild();
  report.processExited = exited;
  if (child) report.launch = { ...report.launch, exitCode: child.exitCode, signal: child.signalCode };
  if (!exited) recordError('process-cleanup', new Error('Owned child did not exit; temporary profile retained.'));
  if (profile && exited) {
    try { await rm(profile, { recursive: true, force: true }); report.temporaryProfileRemoved = true; recordLifecycle('temporary-profile-removed'); }
    catch (error) { recordError('profile-cleanup', error); }
  }
  if (report.before) {
    try { report.after = await inspectIntegrity(bundle); report.unchanged = compareIntegrity(report.before, report.after).unchanged; }
    catch (error) { recordError('final-integrity', error); }
  }
  report.cssPass = report.css?.matchesExpected === true && report.css?.matchesOriginal === true &&
    report.activeUnchanged === true && report.unchanged === true && !report.errors.length && !lifecycle.interrupted;
  report.verdict = report.cssPass ? 'pass' : 'incomplete';
  if (report.status === 'ready') report.status = lifecycle.interrupted ? 'interrupted' : 'complete';
  recordLifecycle('cleanup-finished', { processExited: exited });
  report.finishedAt = new Date().toISOString();
  await save();
}

async function command(input) {
  checkInterrupted();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Supply a JSON command object.');
  switch (input.command ?? input.cmd) {
    case 'targets': return { targets: (await targets()).map(safeTarget) };
    case 'buttons': return buttons(input.targetId, input.selector);
    case 'preview': return preview(input.targetId, input.selector);
    case 'apply': {
      await releaseTrial();
      report.activeUnchanged = false;
      selected = await attach(input.targetId);
      report.target = selected.safe;
      trial = new CosmeticTrial(selected.page, input.selector);
      report.css = { targetId: input.targetId, selector: input.selector };
      try {
        await requireTarget(selected);
        report.css.original = await trial.init();
        await capture('before');
        await requireTarget(selected);
        const result = await trial.apply(); styled = true;
        report.css = { ...report.css, ...result };
        await requireTarget(selected);
        if (!result.matchesExpected) throw new Error('CSS did not produce the expected computed appearance.');
        await capture('green');
        report.active = await inspectIntegrity(bundle);
        report.activeUnchanged = compareIntegrity(report.before, report.active).unchanged;
        await requireTarget(selected);
        await save();
        return { ...result, integrityUnchanged: report.activeUnchanged };
      } catch (error) {
        try { if (trial && styled) await removeTrial(); await releaseTrial(); }
        catch (cleanupError) { recordError('apply-cleanup', cleanupError); }
        throw error;
      }
    }
    case 'inspect': {
      if (!trial) throw new Error('Apply a CSS trial first.');
      await requireTarget(selected);
      const result = await trial.inspect();
      await requireTarget(selected);
      return result;
    }
    case 'remove': { const result = await removeTrial(); await save(); return result; }
    case 'stop': await stop(); return { stopped: true, verdict: report.verdict, unchanged: report.unchanged, report: folder && path.join(folder, 'report.json') };
    default: throw new Error('Commands: targets, buttons, preview, apply, inspect, remove, stop.');
  }
}

try {
  if ((extra.length && !rancherImage) || typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) throw new Error('Usage: pipe-compatibility-session.mjs <catalog-slug> [rancher only: --rancher-image]');
  const catalog = JSON.parse(await readFile(path.join(root, 'compatibility/apps.json'), 'utf8'));
  if (!Array.isArray(catalog)) throw new Error('App catalog must be an array.');
  const seen = new Set();
  for (const app of catalog) {
    if (!app || typeof app.slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(app.slug) || seen.has(app.slug) ||
        typeof app.name !== 'string' || !app.name.trim() || app.name.length > 200 || /[\x00-\x1f\x7f]/.test(app.name) ||
        typeof app.bundlePath !== 'string' || path.dirname(app.bundlePath) !== '/Applications' ||
        path.normalize(app.bundlePath) !== app.bundlePath || !/^.+\.app$/.test(path.basename(app.bundlePath)) || /[\x00-\x1f\x7f]/.test(app.bundlePath)) throw new Error('Invalid or duplicate fixed app catalog entry.');
    seen.add(app.slug);
  }
  const app = catalog.find(item => item.slug === slug);
  if (!app) throw new Error('Unknown app slug; only the fixed catalog is accepted.');
  bundle = rancherImage ? path.join(rancherVolume, 'Rancher Desktop.app') : app.bundlePath;
  folder = path.join(root, 'output/compatibility', slug, 'pipe', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(folder, { recursive: true });
  report.name = app.name; report.bundle = bundle;
  report.bundleSource = rancherImage ? await requireRancherImage(app.install?.sha256) : { mode: 'installed-application' };
  const plist = path.join(bundle, 'Contents/Info.plist');
  const { stdout: executableName } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist]);
  const name = executableName.trim();
  if (!name || path.basename(name) !== name || ['.', '..'].includes(name) || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid bundle executable name.');
  executable = path.join(bundle, 'Contents/MacOS', name);
  report.executable = executable;
  const { stdout: version } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
  report.version = version.trim();
  checkInterrupted();
  await requireNoExistingApp();
  report.before = await inspectIntegrity(bundle);
  checkInterrupted();
  profile = await mkdtemp(path.join(tmpdir(), `extensions-anywhere-${slug}-pipe-`));
  await requireNoExistingApp();
  if (rancherImage) report.bundleSource = await requireRancherImage(app.install?.sha256);
  checkInterrupted();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launchArguments = ['--remote-debugging-pipe', `--user-data-dir=${profile}`];
  // Compass documents this parser option for additional command-line flags.
  // It is fixed to Compass, never an arbitrary caller-supplied argument list.
  if (slug === 'compass') launchArguments.unshift('--ignoreAdditionalCommandLineFlags');
  child = spawn(executable, launchArguments, { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  report.launch = { pid: child.pid, flags: launchArguments.map(arg => arg.startsWith('--user-data-dir=') ? '--user-data-dir=<temporary>' : arg), profileIsolationGuaranteed: false };
  if (slug === 'compass') report.launch.adapter = { name: 'documented-compass-cli-options', source: 'https://www.mongodb.com/docs/compass/settings/command-line-options/' };
  child.on('error', error => { recordError('launch', error); pipe?.close(); });
  child.stderr.on('data', chunk => { report.stderrBytes = (report.stderrBytes ?? 0) + chunk.length; });
  pipe = new PipeCDP(child.stdio[4], child.stdio[3]);
  pipe.on('disconnected', error => {
    disconnected = true;
    if (!lifecycle.stopping && !lifecycle.interrupted) { recordError('transport', error); lines?.close(); }
  });
  const versionInfo = await pipe.call('Browser.getVersion');
  report.browser = { product: versionInfo.product, protocolVersion: versionInfo.protocolVersion };
  report.targets = (await targets()).map(safeTarget);
  checkInterrupted();
  if (disconnected) throw new Error('Pipe disconnected before command input.');
  report.status = 'ready'; await save();
  emit({ ready: true, slug, pid: child.pid, targets: report.targets, report: path.join(folder, 'report.json') });
  lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  if (lifecycle.interrupted || disconnected) { lines.close(); throw new Error('Session ended before command input.'); }
  try {
    for await (const line of lines) {
      if (lifecycle.interrupted || disconnected) break;
      if (!line.trim()) continue;
      try {
        if (line.length > 8192) throw new Error('Command exceeds 8 KiB.');
        emit({ ok: true, ...(await command(JSON.parse(line))) });
      } catch (error) {
        recordError('command', error); await save();
        emit({ ok: false, error: report.errors.at(-1).message });
      }
      if (lifecycle.stopping) break;
    }
  } finally { lines.close(); }
} catch (error) {
  report.status = lifecycle.interrupted ? 'interrupted' : 'trial-incomplete';
  recordError('session', error);
  emit({ ok: false, error: report.errors.at(-1).message });
} finally {
  try { await stop(); }
  finally { process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm); }
  process.exitCode = report.verdict === 'pass' ? 0 : 1;
}
