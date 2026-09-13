// Bounded launch-lifecycle observation. No attachment, app configuration edits,
// or renderer commands. Only this diagnostic's child processes are stopped.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';

const exec = promisify(execFile);
const bundle = '/Applications/Discord.app';
const executable = `${bundle}/Contents/MacOS/Discord`;
const destination = path.resolve('output/compatibility/discord/startup-diagnostic.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function processes() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,comm=']);
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || !match[3].startsWith(`${bundle}/`)) return [];
    return [{ pid: +match[1], ppid: +match[2], role: match[3] === executable ? 'main' : 'helper' }];
  });
}
const categories = {
  secondaryInstance: /secondary instance|second instance|already running|single.instance.*(?:fail|quit|exit)/i,
  bootstrap: /bootstrap|bootstrapp?ing/i,
  relaunch: /relaunch|restarting|restart(?:ing)? app/i,
  update: /updat(?:e|er|ing)/i,
  modules: /modules?|installed packages/i,
  splash: /splash/i,
  quit: /quitting|will.quit|before.quit|exiting|quit requested/i,
  permissionError: /EACCES|EPERM|permission denied/i,
  addressInUse: /EADDRINUSE|address already in use/i,
  networkError: /ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|ERR_(?:CONNECTION|NAME|NETWORK|CERT)/i,
  javascriptError: /TypeError:|ReferenceError:|SyntaxError:|UnhandledPromiseRejection/i,
  fatalError: /FATAL:|segmentation fault|uncaught exception|crash(?:ed|ing)/i,
};
const initial = await processes();
if (initial.length) throw new Error('Discord is already running; preserving it and refusing this diagnostic.');
const report = {
  bundle, executable, startedAt: new Date().toISOString(),
  purpose: 'Compare normal and documented debugging launches without attaching. Raw logs are neither persisted nor emitted.',
  preexistingProcesses: initial, before: await inspectIntegrity(bundle), trials: [],
};
await mkdir(path.dirname(destination), { recursive: true });
const save = () => writeFile(destination, JSON.stringify(report, null, 2) + '\n');
await save();
for (const mode of ['normal-fresh-profile', 'debugging-fresh-profile']) {
  if ((await processes()).length) {
    report.stoppedReason = 'A Discord process remains; no further launch or cleanup of an uncertain process attempted.';
    break;
  }
  const profile = await mkdtemp(path.join(tmpdir(), 'extensions-anywhere-discord-startup-'));
  const args = [`--user-data-dir=${profile}`];
  if (mode.startsWith('debugging')) args.push('--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1');
  const trial = { mode, requestedProfile: profile, flags: args, categories: {}, observedProcesses: [], startedAt: new Date().toISOString() };
  report.trials.push(trial);
  const start = performance.now();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  trial.pid = child.pid;
  let exitObserved = false, exitAt;
  const buffers = { stdout: '', stderr: '' };
  const consume = (line, stream) => {
    const elapsedMs = Math.round(performance.now() - start);
    for (const [name, pattern] of Object.entries(categories)) if (pattern.test(line)) {
      const category = trial.categories[name] ||= { count: 0, firstMs: elapsedMs, lastMs: elapsedMs };
      category.count++; category.lastMs = elapsedMs;
    }
    if (/DevTools listening on ws:\/\/127\.0\.0\.1:\d+\//.test(line)) {
      trial.loopbackEndpointAnnouncedMs ??= elapsedMs;
      trial.endpointAnnouncementStream = stream;
    }
  };
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
    buffers[stream] += chunk.toString();
    const lines = buffers[stream].split(/\r?\n/); buffers[stream] = lines.pop().slice(-16000);
    for (const line of lines) consume(line, stream);
  });
  child.on('error', error => { trial.spawnErrorCode = error.code ?? error.name; });
  child.on('exit', (code, signal) => {
    exitObserved = true; exitAt = performance.now();
    trial.exit = { code, signal, elapsedMs: Math.round(exitAt - start), requestedByDiagnostic: Boolean(trial.stopRequestedMs) };
  });
  const seen = new Map();
  try {
    while (performance.now() - start < 20000) {
      for (const proc of await processes()) {
        if (!seen.has(proc.pid)) {
          const row = { ...proc, firstMs: Math.round(performance.now() - start), ownedDirectChild: proc.pid === child.pid };
          seen.set(proc.pid, row); trial.observedProcesses.push(row);
        }
      }
      if (exitObserved && performance.now() - exitAt >= 2000) break;
      await delay(250);
    }
  } finally {
    if (!exitObserved) {
      trial.stopRequestedMs = Math.round(performance.now() - start);
      child.kill('SIGTERM');
      for (let n = 0; n < 30 && !exitObserved; n++) await delay(100);
      if (!exitObserved) {
        trial.forcedOwnedChildStop = true; child.kill('SIGKILL');
        for (let n = 0; n < 30 && !exitObserved; n++) await delay(100);
      }
    }
    for (const stream of ['stdout', 'stderr']) if (buffers[stream]) consume(buffers[stream], stream);
    let remaining = await processes();
    for (let n = 0; n < 20 && remaining.length; n++) { await delay(100); remaining = await processes(); }
    trial.remainingProcesses = remaining;
    if (exitObserved && !remaining.length) {
      await rm(profile, { recursive: true, force: true }); trial.temporaryProfileRemoved = true;
    } else trial.temporaryProfileRemoved = false;
    trial.elapsedMs = Math.round(performance.now() - start);
    trial.integrity = compareIntegrity(report.before, await inspectIntegrity(bundle));
    await save();
    console.log(JSON.stringify({ mode, pid: trial.pid, exit: trial.exit, categories: trial.categories, endpointAnnouncedMs: trial.loopbackEndpointAnnouncedMs, remainingProcesses: remaining, integrityUnchanged: trial.integrity.unchanged }));
  }
}
report.after = await inspectIntegrity(bundle);
report.integrity = compareIntegrity(report.before, report.after);
report.finishedAt = new Date().toISOString();
await save();
console.log(JSON.stringify({ report: destination, trials: report.trials.length, unchanged: report.integrity.unchanged }));
