// Fixed cosmetic proof for Claude's explicitly enabled, local main-process inspector.
// No launch flags, private preferences, bundle edits, or arbitrary script/CSS input.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from '../lib/cdp.mjs';
import { getProcessIdentity, sameProcessIdentity } from '../lib/process-identity.mjs';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';
import { StylesheetRemoval } from '../lib/stylesheet-removal.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = '/Applications/Claude.app';
const executable = `${bundle}/Contents/MacOS/Claude`;
const [pidText, mode, captureFlag, ...extra] = process.argv.slice(2);
const fullApp = captureFlag === '--full-app';
if (!/^[1-9]\d*$/.test(pidText ?? '') || !Number.isSafeInteger(Number(pidText)) ||
    !['--preview', '--verify'].includes(mode) || (captureFlag !== undefined && !fullApp) || extra.length) {
  throw new Error('Usage: node scripts/verify-claude-developer-mode.mjs <Claude PID> --preview|--verify [--full-app]');
}
const pid = Number(pidText);
const folder = path.join(root, 'output/compatibility/claude/developer-mode', new Date().toISOString().replaceAll(':', '-'));
const report = { slug: 'claude', name: 'Claude', bundle, startedAt: new Date().toISOString(),
  mode: 'official-developer-mode-main-inspector', operation: mode.slice(2), status: 'starting', verdict: 'incomplete',
  setup: { interface: 'Developer > Enable Main Process Debugger', performedByScript: false },
  scope: { mainProcessJavaScript: true, rendererJavaScript: 'fixed read-only appearance checks',
    arbitraryExtensionsVerified: false, uiDrivenInjection: false, existingProfile: true, ownedLaunch: false }, errors: [] };
const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
const targetUrl = 'https://claude.ai/new';
const selector = 'button[aria-label="Use incognito"]';
const css = `${selector} { background-color: rgb(22, 163, 74) !important; color: rgb(255, 255, 255) !important; background-image: none !important; }`;
const rollbackMs = 15000;
let identity, cdp, targetId, inspectorEndpoint, cleaning = false, interrupted = false;
const onSignal = () => { interrupted = true; };
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
const save = () => writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const removal = new StylesheetRemoval(save);
report.stylesheetCleanup = removal.state;
report.automaticRollbackMs = rollbackMs;
report.cssOrigin = 'author';
report.captureMethod = 'Electron webContents.debugger / Page.captureScreenshot';
report.captureScope = fullApp ? 'Control crops and full visible app-content viewport; native window frame excluded' : 'Control crops';
const recordError = (phase, error) => report.errors.push({ phase, message: String(error.message ?? error).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[URL omitted]').slice(0, 500) });

async function requireOwner() {
  if (interrupted && !cleaning) throw new Error('Interrupted; restoring the trial.');
  const current = await getProcessIdentity(pid);
  if (!current || current.executable !== executable || current.uid !== process.getuid() ||
      (identity && !sameProcessIdentity(identity, current))) throw new Error('Selected Claude process identity changed.');
  identity ??= current;
  // Require this PID to be the sole listener, on IPv4 loopback only.
  const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-iTCP:9229', '-sTCP:LISTEN', '-Fpn'], { timeout: 3000, maxBuffer: 65536 });
  const pids = [...stdout.matchAll(/^p(\d+)$/gm)].map(m => Number(m[1]));
  const addresses = [...stdout.matchAll(/^n(.+)$/gm)].map(m => m[1]);
  if (pids.length !== 1 || pids[0] !== pid || addresses.length !== 1 || addresses[0] !== '127.0.0.1:9229') {
    throw new Error('Inspector must belong exclusively to the selected Claude process on 127.0.0.1:9229.');
  }
}

async function evaluate(expression, checkAfter = true) {
  await requireOwner();
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 5000 });
  if (result.exceptionDetails) {
    const reason = String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '').split('\n')[0].slice(0, 200);
    throw new Error(`Fixed diagnostic expression failed in Claude: ${reason}`);
  }
  if (result.result?.type === 'object' && result.result.subtype === 'error') throw new Error('Fixed diagnostic returned an error.');
  if (checkAfter) await requireOwner();
  return result.result?.value;
}

// Application and appearance reads stay on this one explicitly selected surface.
function inTarget(operation) {
  return `(async()=>{const w=${electron}.webContents.fromId(${targetId});
    if(!w||w.isDestroyed()||w.getType()!=='window'||w.getURL()!==${JSON.stringify(targetUrl)}) throw Error('New-chat surface changed');
    return ${operation};})()`;
}

const snapshotExpression = `(()=>{
  const buttons=document.querySelectorAll(${JSON.stringify(selector)});
  if(buttons.length!==1) throw Error('Expected exactly one incognito button');
  const b=buttons[0];
  if(b.getAttribute('aria-label')!=='Use incognito') throw Error('Expected the incognito button');
  const c=getComputedStyle(b),r=b.getBoundingClientRect();
  if(c.display==='none'||c.visibility!=='visible'||Number(c.opacity)!==1||r.width<=0||r.height<=0||r.x<0||r.y<0||r.right>innerWidth||r.bottom>innerHeight) throw Error('Button is not fully visible');
  const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
  if(top!==b&&!b.contains(top)) throw Error('Button is obscured');
  return {label:'Use incognito',background:c.backgroundColor,color:c.color,backgroundImage:c.backgroundImage,box:{x:r.x,y:r.y,width:r.width,height:r.height}};
})()`;
const snapshot = () => evaluate(inTarget(`w.executeJavaScript(${JSON.stringify(snapshotExpression)},false)`));
const appearanceMatches = (a, b) => ['background', 'color', 'backgroundImage'].every(k => a[k] === b[k]);
async function observe(expected) {
  const deadline = Date.now() + 1500;
  let value;
  do {
    value = await snapshot();
    if (appearanceMatches(value, expected)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return value;
}
async function capture(name, current) {
  const r = current.box;
  const rect = { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.x + r.width) - Math.floor(r.x), height: Math.ceil(r.y + r.height) - Math.floor(r.y) };
  if (!Object.values(rect).every(Number.isSafeInteger) || rect.width > 1600 || rect.height > 500) throw new Error('Unexpected control capture dimensions.');
  const captureOptions = { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: false };
  const data = await evaluate(inTarget(`(async()=>{
    if(w.debugger.isAttached())throw Error('A renderer debugger is already attached');
    w.debugger.attach('1.3');
    try{return (await w.debugger.sendCommand('Page.captureScreenshot',${JSON.stringify(captureOptions)})).data;}
    finally{w.debugger.detach();}
  })()`));
  if (typeof data !== 'string' || data.length > 2_000_000) throw new Error('Unexpected screenshot size.');
  await writeFile(path.join(folder, `${name}.png`), Buffer.from(data, 'base64'));
  const result = { image: `${name}.png`, box: rect };
  if (fullApp) {
    const full = await evaluate(inTarget(`(async()=>{
      if(w.debugger.isAttached())throw Error('A renderer debugger is already attached');
      w.debugger.attach('1.3');
      try{
        const metrics=await w.debugger.sendCommand('Page.getLayoutMetrics');
        const v=metrics.cssVisualViewport;
        if(!v||![v.clientWidth,v.clientHeight].every(Number.isFinite)||v.clientWidth<=0||v.clientHeight<=0||v.clientWidth>8192||v.clientHeight>8192||v.clientWidth*v.clientHeight>32000000)throw Error('Unexpected viewport dimensions');
        const shot=await w.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        return {data:shot.data,viewport:{width:v.clientWidth,height:v.clientHeight}};
      }finally{w.debugger.detach();}
    })()`));
    if (typeof full?.data !== 'string' || full.data.length > 32_000_000) throw new Error('Unexpected full-app screenshot size.');
    const bytes = Buffer.from(full.data, 'base64');
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid full-app PNG.');
    const pixels = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (!pixels.width || !pixels.height || pixels.width > 16384 || pixels.height > 16384 || pixels.width * pixels.height > 64_000_000) throw new Error('Unexpected full-app PNG dimensions.');
    // A delayed screenshot must not be labelled green after automatic rollback.
    const afterCapture = await snapshot();
    if (!appearanceMatches(afterCapture, current) || JSON.stringify(afterCapture.box) !== JSON.stringify(current.box)) throw new Error('Control appearance changed during full-app capture.');
    const image = `${name}-full-app.png`;
    await writeFile(path.join(folder, image), bytes);
    result.fullApp = { image, viewport: full.viewport, pixels, nativeWindowFrameIncluded: false, appearanceRechecked: true };
  }
  return result;
}

async function disconnect(connection) {
  if (!connection || connection.socket.readyState === 3) return true;
  return new Promise(resolve => {
    let force, deadline;
    const done = () => { clearTimeout(force); clearTimeout(deadline); connection.socket.off('close', done); resolve(connection.socket.readyState === 3); };
    connection.socket.once('close', done);
    force = setTimeout(() => connection.socket.terminate(), 1000);
    deadline = setTimeout(done, 2000);
    connection.close();
  });
}

async function reconnectForCleanup() {
  await requireOwner();
  if (!inspectorEndpoint) throw new Error('No pinned inspector endpoint for cleanup.');
  if (!await disconnect(cdp)) throw new Error('Old inspector connection did not close.');
  await requireOwner();
  cdp = new CDP(inspectorEndpoint, 8000);
  await cdp.ready;
  await requireOwner();
  report.cleanupReconnected = true;
}

function removeKnownKey(key) {
  // Removal touches only this returned key on the same pinned window. A route
  // change must stop appearance reads, but must not prevent known-key cleanup.
  return evaluate(`(async()=>{const w=${electron}.webContents.fromId(${targetId});
    if(!w||w.isDestroyed()||w.getType()!=='window') throw Error('Selected window no longer exists');
    await w.removeInsertedCSS(${JSON.stringify(key)});return true;})()`, false);
}

await mkdir(folder, { recursive: true });
try {
  await requireOwner(); report.process = identity;
  report.before = await inspectIntegrity(bundle);
  report.version = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', `${bundle}/Contents/Info.plist`])).stdout.trim();
  const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw new Error('Inspector discovery failed.');
  const targets = await response.json();
  if (!Array.isArray(targets) || targets.length !== 1 || targets[0].type !== 'node') throw new Error('Expected one Node inspector target.');
  const endpoint = new URL(targets[0].webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || endpoint.host !== '127.0.0.1:9229' || endpoint.username || endpoint.password) throw new Error('Unexpected inspector endpoint.');
  inspectorEndpoint = endpoint.href;
  await requireOwner(); cdp = new CDP(inspectorEndpoint, 8000);
  report.runtime = await evaluate('({electron:process.versions.electron,node:process.versions.node})');
  const candidates = await evaluate(`${electron}.webContents.getAllWebContents().filter(w=>w.getType()==='window'&&w.getURL()===${JSON.stringify(targetUrl)}).map(w=>w.id)`);
  if (!Array.isArray(candidates) || candidates.length !== 1 || !Number.isSafeInteger(candidates[0])) throw new Error('Expected one Claude new-chat surface.');
  targetId = candidates[0]; report.target = { id: targetId, type: 'window', url: targetUrl };
  report.css = { selector, original: await snapshot() };
  report.captures = { before: await capture('before', report.css.original) };
  await save();
  if (mode === '--verify') {
    const settled = await snapshot();
    if (!appearanceMatches(settled, report.css.original) || JSON.stringify(settled.box) !== JSON.stringify(report.css.original.box)) throw new Error('Control changed after the baseline capture; retry preview before a new trial.');
    // Revalidate immediately before the sole fixed write. The bounded rollback
    // remains in the app if the client dies or loses the insertion response.
    await removal.insert(() => evaluate(inTarget(`w.executeJavaScript(${JSON.stringify(snapshotExpression)},false).then(async()=>{
      if(w.isDestroyed()||w.getURL()!==${JSON.stringify(targetUrl)}) throw Error('New-chat surface changed');
      const key=await w.insertCSS(${JSON.stringify(css)},{cssOrigin:'author'});
      const timer=setTimeout(()=>{if(!w.isDestroyed())w.removeInsertedCSS(key).catch(()=>{});},${rollbackMs});
      timer.unref();return key;
    })`), false), requireOwner);
    report.css.applied = await observe({ background: 'rgb(22, 163, 74)', color: 'rgb(255, 255, 255)', backgroundImage: 'none' });
    report.css.matchesExpected = appearanceMatches(report.css.applied, { background: 'rgb(22, 163, 74)', color: 'rgb(255, 255, 255)', backgroundImage: 'none' });
    report.captures.green = await capture('green', report.css.applied);
    report.active = await inspectIntegrity(bundle);
    report.activeUnchanged = compareIntegrity(report.before, report.active).unchanged;
    await save();
  }
  report.status = mode === '--preview' ? 'preview-complete' : 'trial-complete';
} catch (error) { recordError('trial', error); report.status = 'trial-incomplete'; }
finally {
  cleaning = true;
  if (removal.state.key) {
    try {
      await removal.remove({ remove: removeKnownKey, checkAfter: requireOwner,
        disconnected: () => cdp?.socket.readyState !== 1, reconnect: reconnectForCleanup });
      report.css.restored = await observe(report.css.original);
      report.css.matchesOriginal = appearanceMatches(report.css.restored, report.css.original);
      report.captures.restored = await capture('restored', report.css.restored);
    } catch (error) { recordError('stylesheet-restoration', error); }
  }
  report.stylesheetRemovalAcknowledged = removal.state.status === 'removed';
  report.stylesheetRemoved = report.stylesheetRemovalAcknowledged && report.css?.matchesOriginal === true;
  report.cleanupUnresolved = ['insertion-pending', 'application-unknown', 'removal-pending'].includes(removal.state.status) ||
    (report.stylesheetRemovalAcknowledged && report.css?.matchesOriginal !== true);
  try { report.controllerDisconnected = await disconnect(cdp); }
  catch (error) { report.controllerDisconnected = false; recordError('controller-disconnect', error); }
  if (report.before) {
    try { report.after = await inspectIntegrity(bundle); report.unchanged = compareIntegrity(report.before, report.after).unchanged; }
    catch (error) { recordError('final-integrity', error); }
  } else { report.finalIntegritySkipped = 'No valid before baseline was established.'; }
  report.interrupted = interrupted;
  report.cssPass = report.css?.matchesExpected === true && report.css?.matchesOriginal === true &&
    report.stylesheetRemoved === true && report.controllerDisconnected === true && report.activeUnchanged === true && report.unchanged === true && !report.errors.length && !interrupted;
  report.verdict = report.cssPass ? 'pass' : 'incomplete';
  report.visualReviewRequired = true;
  report.setupRestorationRequired = true;
  report.finishedAt = new Date().toISOString(); await save();
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
}
console.log(JSON.stringify({ report: path.join(folder, 'report.json'), ...report }));
process.exitCode = report.cssPass || (mode === '--preview' && !report.errors.length) ? 0 : 1;
