// Supervised, fixed-app CSS trials. No target is attached until a stdin command
// explicitly selects its ID. Endpoint access proves neither general extension
// support nor compatibility with every profile, page, or version of an app.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { CDP } from '../lib/cdp.mjs';
import { CosmeticTrial } from '../lib/cosmetic-trial.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';
import { getProcessIdentity, findProcessesByExecutable, sameProcessIdentity } from '../lib/process-identity.mjs';

const apps = Object.freeze({
  discord: 'Discord.app', vscode: 'Visual Studio Code.app', slack: 'Slack.app',
  notion: 'Notion.app', figma: 'Figma.app', signal: 'Signal.app',
  postman: 'Postman.app', obsidian: 'Obsidian.app',
  github: 'GitHub Desktop.app', claude: 'Claude.app',
  evernote: 'Evernote.app', mattermost: 'Mattermost.app',
  joplin: 'Joplin.app', compass: 'MongoDB Compass.app'
});
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = value => console.log(JSON.stringify(value));
const errorText = error => String(error.message ?? error).slice(0, 1500);
const [slug, ...options] = process.argv.slice(2);
if (!Object.hasOwn(apps, slug) || options.some(value => !/^--(?:existing-pid|port)=\d+$/.test(value))) {
  throw new Error('Usage: compatibility-session.mjs <fixed-app-slug> [--existing-pid=N --port=N]');
}
const supplied = Object.fromEntries(options.map(value => value.slice(2).split('=')));
const existingPID = supplied['existing-pid'] ? Number(supplied['existing-pid']) : null;
let port = supplied.port ? Number(supplied.port) : null;
if (options.length !== Object.keys(supplied).length ||
    ((existingPID || port) && (!existingPID || !port)) ||
    (existingPID !== null && (!Number.isSafeInteger(existingPID) || existingPID <= 0)) ||
    (port !== null && (port < 1 || port > 65535))) throw new Error('Invalid existing endpoint options.');

const bundle = path.join('/Applications', apps[slug]);
const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'output', 'compatibility', slug);
const report = { slug, bundle, ownerPid: process.pid, startedAt: new Date().toISOString(), status: 'starting', errors: [] };
let executable, child, pid, profile, trial, connection, lines, ownerIdentity, interrupted = false, styled = false, stopped = false;
const save = () => writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const recordError = (phase, error) => report.errors.push({ phase, message: errorText(error) });

function safeTarget(target) {
  let url = '(unrecognized URL)';
  try {
    const parsed = new URL(target.url);
    const first = parsed.pathname.split('/').filter(Boolean)[0];
    const known = ['login', 'signin', 'ssb', 'app', 'welcome', 'onboarding', 'channels'];
    const pathname = !first ? '/' : known.includes(first) ? `/${first}/…` : '/…';
    url = ['https:', 'http:'].includes(parsed.protocol) ? `${parsed.origin}${pathname}` : `${parsed.protocol}${pathname}`;
  } catch {}
  return { id: target.id, type: target.type, url };
}

async function requireOwner() {
  if (child && (child.exitCode !== null || child.signalCode !== null)) {
    throw new Error(`Test launch exited (${child.exitCode ?? child.signalCode}); no stable endpoint established.`);
  }
  const current = await getProcessIdentity(pid);
  if (!current || current.executable !== await realpath(executable) || current.uid !== process.getuid()) throw new Error('Endpoint process does not match the selected app executable.');
  if (ownerIdentity && !sameProcessIdentity(ownerIdentity, current)) throw new Error('Endpoint process identity changed.');
  if (!ownerIdentity) { ownerIdentity = current; report.launch.identity = current; }
  const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  const addresses = stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  const matched = addresses.filter(address => address.endsWith(`:${port}`));
  if (!matched.length || matched.some(address => address !== `127.0.0.1:${port}`)) {
    throw new Error('The selected process must own an exclusively 127.0.0.1 debugger listener.');
  }
}

async function targets() {
  await requireOwner();
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Target listing failed (${response.status}).`);
  const list = await response.json();
  if (!Array.isArray(list)) throw new Error('Invalid target listing.');
  await requireOwner();
  return list;
}

async function connect(targetId) {
  if (typeof targetId !== 'string' || !targetId) throw new Error('Supply an explicit targetId.');
  const target = (await targets()).find(item => item.id === targetId && item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('The selected page target is not available on this app endpoint.');
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port) {
    throw new Error('Target WebSocket does not match the verified endpoint.');
  }
  const cdp = new CDP(url.href);
  try { await cdp.ready; return cdp; } catch (error) { cdp.close(); throw error; }
}

async function buttons(targetId) {
  const cdp = await connect(targetId);
  try {
    await cdp.call('Page.enable');
    await cdp.call('DOM.enable');
    await cdp.call('CSS.enable');
    const { root } = await cdp.call('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.call('DOM.querySelectorAll', {
      nodeId: root.nodeId, selector: 'button,[role="button"],input[type="submit"],a'
    });
    const { cssVisualViewport: viewport } = await cdp.call('Page.getLayoutMetrics');
    const candidates = [];
    for (const nodeId of nodeIds.slice(0, 100)) {
      try {
        const { model } = await cdp.call('DOM.getBoxModel', { nodeId });
        if (!model || model.width <= 0 || model.height <= 0) continue;
        if (viewport) {
          const xs = model.border.filter((_, index) => index % 2 === 0);
          const ys = model.border.filter((_, index) => index % 2 === 1);
          if (Math.max(...xs) <= viewport.pageX || Math.min(...xs) >= viewport.pageX + viewport.clientWidth ||
              Math.max(...ys) <= viewport.pageY || Math.min(...ys) >= viewport.pageY + viewport.clientHeight) continue;
        }
        const { computedStyle } = await cdp.call('CSS.getComputedStyleForNode', { nodeId });
        const style = Object.fromEntries(computedStyle.map(item => [item.name, item.value]));
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        const { node } = await cdp.call('DOM.describeNode', { nodeId, depth: 0 });
        const attrs = {};
        for (let i = 0; i < (node.attributes?.length ?? 0); i += 2) {
          if (['id', 'class', 'type'].includes(node.attributes[i])) attrs[node.attributes[i]] = node.attributes[i + 1].slice(0, 1000);
        }
        candidates.push({ nodeId, tag: node.localName || node.nodeName, ...attrs, box: model.border });
      } catch { /* A disappearing or non-layout node is not a button candidate. */ }
    }
    return { candidates, truncated: nodeIds.length > 100 };
  } finally { cdp.close(); }
}

async function releaseTrial() {
  if (trial) await trial.dispose();
  trial = null;
  connection?.close();
  connection = null;
  styled = false;
}

async function capture(cdp, selector, name) {
  const { root } = await cdp.call('DOM.getDocument', { depth: 0 });
  const { nodeIds } = await cdp.call('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
  if (nodeIds.length !== 1) throw new Error('Screenshot requires exactly one selected control.');
  const { model } = await cdp.call('DOM.getBoxModel', { nodeId: nodeIds[0] });
  const x = Math.min(...model.border.filter((_, i) => i % 2 === 0));
  const y = Math.min(...model.border.filter((_, i) => i % 2 === 1));
  const { data } = await cdp.call('Page.captureScreenshot', {
    format: 'png', clip: { x, y, width: model.width, height: model.height, scale: 1 }
  });
  await writeFile(path.join(folder, `${name}.png`), Buffer.from(data, 'base64'));
}

async function stop() {
  if (stopped) return;
  stopped = true;
  if (trial && styled) {
    try { report.css = { ...report.css, ...(await trial.remove()) }; }
    catch (error) { recordError('restore', error); }
  }
  try { await releaseTrial(); } catch (error) {
    recordError('stylesheet-cleanup', error);
    connection?.close();
  }
  let terminated = !child?.pid || child.exitCode !== null || child.signalCode !== null;
  if (!terminated) {
    terminated = await new Promise(resolve => {
      let killTimer, deadline;
      const finish = result => {
        clearTimeout(killTimer); clearTimeout(deadline);
        child.off('exit', onExit); resolve(result);
      };
      const onExit = () => finish(true);
      child.once('exit', onExit);
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      deadline = setTimeout(() => finish(false), 6000);
      child.kill('SIGTERM');
    });
  }
  report.launch = { ...report.launch, exitCode: child?.exitCode, signal: child?.signalCode };
  if (!terminated) recordError('process-cleanup', new Error('Owned child did not exit before the cleanup deadline; its profile was retained.'));
  if (profile && terminated) {
    try { await rm(profile, { recursive: true, force: true }); report.temporaryProfileRemoved = true; }
    catch (error) { recordError('profile-cleanup', error); }
  }
  if (report.before) {
    try {
      report.after = await inspectIntegrity(bundle);
      report.unchanged = compareIntegrity(report.before, report.after).unchanged;
    } catch (error) { report.unchanged = false; recordError('final-integrity', error); }
  }
  if (report.status === 'ready') report.status = 'complete';
  report.verdict = report.css?.matchesExpected && report.css?.matchesOriginal &&
    report.activeUnchanged && report.unchanged && !report.errors.length ? 'pass' : 'incomplete';
  report.finishedAt = new Date().toISOString();
  await save();
}

async function command(input) {
  switch (input.command ?? input.cmd) {
    case 'targets': return { targets: (await targets()).map(safeTarget) };
    case 'buttons': return buttons(input.targetId);
    case 'apply': {
      try {
      await releaseTrial();
      connection = await connect(input.targetId);
      trial = new CosmeticTrial(connection, input.selector);
      await trial.init();
      await capture(connection, input.selector, 'before');
      const result = await trial.apply();
      styled = true;
      report.css = { targetId: input.targetId, selector: input.selector, ...result };
      report.active = await inspectIntegrity(bundle);
      report.activeUnchanged = compareIntegrity(report.before, report.active).unchanged;
      await capture(connection, input.selector, 'green');
      await save();
      return { ...result, integrityUnchanged: report.activeUnchanged };
      } catch (error) {
        try {
          if (trial) {
            const restored = await trial.remove();
            report.css = { ...report.css, ...restored };
          }
          await releaseTrial();
        } catch (cleanupError) { recordError('apply-cleanup', cleanupError); }
        throw error;
      }
    }
    case 'inspect':
      if (!trial) throw new Error('Apply a supervised trial first.');
      return trial.inspect();
    case 'remove': {
      if (!trial) throw new Error('No trial to remove.');
      const result = await trial.remove();
      styled = false;
      report.css = { ...report.css, ...result };
      await capture(connection, report.css.selector, 'restored');
      await save();
      return result;
    }
    case 'verify': {
      const integrity = await inspectIntegrity(bundle);
      const result = compareIntegrity(report.before, integrity);
      report[styled ? 'active' : 'latestIntegrity'] = integrity;
      await save();
      return result;
    }
    case 'stop': await stop(); return { stopped: true, unchanged: report.unchanged };
    default: throw new Error('Commands: targets, buttons, apply, inspect, remove, verify, stop.');
  }
}

const cancel = () => {
  interrupted = true;
  if (lines) lines.close();
  else if (!stopped && child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
};
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
await mkdir(folder, { recursive: true });
try {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  for (const [field, key] of Object.entries({ executableName: 'CFBundleExecutable', version: 'CFBundleShortVersionString', build: 'CFBundleVersion', bundleId: 'CFBundleIdentifier' })) {
    const { stdout } = await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
    report[field] = stdout.trim();
  }
  if (!report.executableName || path.basename(report.executableName) !== report.executableName || ['.', '..'].includes(report.executableName)) {
    throw new Error('Invalid app executable metadata.');
  }
  executable = path.join(bundle, 'Contents', 'MacOS', report.executableName);
  report.executable = executable;
  report.before = await inspectIntegrity(bundle);
  if (interrupted) throw new Error('Session interrupted before launch.');
  report.launch = { existing: Boolean(existingPID) };
  await save();
  const deadline = Date.now() + 30000;
  if (existingPID) pid = existingPID;
  else {
    const inventory = await findProcessesByExecutable(executable);
    if (inventory.matches.length) throw new Error('Selected app is already running; use its explicitly verified endpoint or quit it normally first.');
    if (inventory.unresolved.length) throw new Error('Process inventory is incomplete; cannot establish that the selected app is stopped.');
    profile = await mkdtemp(path.join(tmpdir(), `extensions-anywhere-${slug}-`));
    const args = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`];
    if (slug === 'compass') args.unshift('--ignoreAdditionalCommandLineFlags');
    if (slug === 'vscode') args.push('--new-window', '--disable-extensions');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    // Register immediately: metadata persistence below yields to process events.
    let launchError;
    child.on('error', error => { launchError = error; });
    pid = child.pid;
    report.launch = { existing: false, pid, profile, arguments: args };
    await save();
    port = await new Promise((resolve, reject) => {
      let buffer = '';
      let settled = false;
      const timer = setTimeout(() => finish(new Error('No debugging endpoint announced within the 30-second startup deadline.')), Math.max(1, deadline - Date.now()));
      const finish = (error, found) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stderr.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        child.stderr.resume();
        error ? reject(error) : resolve(found);
      };
      const onData = chunk => {
        buffer = (buffer + chunk.toString()).slice(-8192);
        const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) finish(null, Number(match[1]));
      };
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`Test launch exited (${code}) before exposing a usable endpoint; cause undetermined.`));
      child.stderr.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
      if (launchError) finish(launchError);
      else if (child.exitCode !== null || child.signalCode !== null) {
        finish(new Error(`Test launch exited (${child.exitCode ?? child.signalCode}) before endpoint discovery; cause undetermined.`));
      }
    });
  }
  report.launch = { ...report.launch, pid, port };
  // Let startup settle before any attachment; do not race a transient endpoint.
  await delay(2000);
  if (interrupted) throw new Error('Session interrupted during startup.');
  if (Date.now() >= deadline) throw new Error('Startup deadline elapsed before endpoint verification.');
  const list = await targets();
  report.targets = list.map(safeTarget);
  report.status = 'ready';
  await save();
  emit({ ready: true, slug, pid, port, targets: report.targets });
  if (interrupted) throw new Error('Session interrupted before command input.');
  lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (interrupted) break;
      if (!line.trim()) continue;
      try { emit({ ok: true, ...(await command(JSON.parse(line))) }); }
      catch (error) { recordError('command', error); await save(); emit({ ok: false, error: errorText(error) }); }
      if (stopped) break;
    }
  } finally {
    lines.close();
  }
} catch (error) {
  report.status = 'trial-incomplete';
  recordError('session', error);
  emit({ ok: false, error: errorText(error) });
  process.exitCode = 1;
} finally {
  try { await stop(); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
