// Supervised, fixed-app launch probe. No renderer commands or app bundle writes.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectIntegrity, compareIntegrity } from '../lib/integrity.mjs';

const names = { discord: 'Discord', vscode: 'Visual Studio Code', slack: 'Slack', notion: 'Notion', figma: 'Figma', signal: 'Signal', postman: 'Postman', obsidian: 'Obsidian', github: 'GitHub Desktop' };
const slug = process.argv[2];
if (!Object.hasOwn(names, slug)) throw new Error('Choose one of the nine active compatibility app slugs.');
const exec = promisify(execFile);
const bundle = `/Applications/${names[slug]}.app`;
const dir = path.resolve('output/compatibility', slug);
await mkdir(dir, { recursive: true });
const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', `${bundle}/Contents/Info.plist`]);
const info = JSON.parse(stdout);
const executable = `${bundle}/Contents/MacOS/${info.CFBundleExecutable}`;
const report = { name: names[slug], bundle, version: info.CFBundleShortVersionString, ownerPid: process.pid, startedAt: new Date().toISOString(), status: 'starting' };
const save = () => writeFile(`${dir}/launch.json`, JSON.stringify(report, null, 2) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, profile, stopping = false, lifetime;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(lifetime);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let n = 0; n < 30 && child.exitCode === null && child.signalCode === null; n++) await delay(100);
    if (child.exitCode === null && child.signalCode === null) {
      // Only this probe's child; never kill a pre-existing app process.
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
  report.exitCode = child?.exitCode; report.signal = child?.signalCode;
  if (profile) { await rm(profile, { recursive: true, force: true }); report.temporaryProfileRemoved = true; }
  try { report.integrity = compareIntegrity(report.before, await inspectIntegrity(bundle)); }
  catch (error) { report.integrityError = error.message; }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ stopped: slug, status: report.status, unchanged: report.integrity?.unchanged }));
  process.exitCode = report.error ? 1 : 0;
}
process.once('SIGTERM', () => stop().catch(error => { console.error(error.message); process.exitCode = 1; }));
process.once('SIGINT', () => stop().catch(error => { console.error(error.message); process.exitCode = 1; }));
try {
  report.before = await inspectIntegrity(bundle);
  profile = await mkdtemp(path.join(tmpdir(), `extensions-anywhere-${slug}-`));
  report.profile = profile;
  const flags = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`];
  if (slug === 'vscode') flags.push('--new-window', '--disable-extensions');
  report.flags = flags;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, flags, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  report.pid = child.pid;
  let announcedPort, launchError, buffer = '';
  child.on('error', error => { launchError = error; });
  child.stderr.on('data', chunk => {
    buffer = (buffer + chunk.toString()).slice(-4000);
    const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) announcedPort = Number(match[1]);
  });
  for (let n = 0; n < 150 && !announcedPort && !launchError && child.exitCode === null && child.signalCode === null; n++) await delay(200);
  if (launchError) throw launchError;
  if (!announcedPort) throw new Error(child.exitCode !== null ? `Launch exited (${child.exitCode}) without a usable endpoint.` : 'No debugging endpoint announced within 30 seconds.');
  report.port = announcedPort;
  await delay(2000); // Do not race a transient endpoint during app startup.
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Launch exited (${child.exitCode ?? child.signalCode}) before a stable attachment.`);
  const { stdout: listeners } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN']);
  const portLines = listeners.split('\n').filter(line => line.includes(`:${announcedPort} (LISTEN)`));
  if (!portLines.length || portLines.some(line => !line.includes(`127.0.0.1:${announcedPort} (LISTEN)`))) throw new Error('Expected app-owned loopback-only listener was not verified.');
  const targets = await (await fetch(`http://127.0.0.1:${announcedPort}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  report.targets = targets.map(({ id, type, url }) => {
    let safeUrl = '';
    try { const u = new URL(url); safeUrl = `${u.protocol}//${u.host}${u.pathname}`; } catch {}
    return { id, type, url: safeUrl };
  });
  report.status = 'endpoint-ready'; await save();
  console.log(JSON.stringify({ slug, ownerPid: process.pid, pid: child.pid, port: announcedPort, targets: report.targets }));
  lifetime = setTimeout(() => stop(), 15 * 60 * 1000);
} catch (error) {
  report.status = 'endpoint-unavailable'; report.error = error.message;
  console.log(JSON.stringify({ slug, status: report.status, error: report.error }));
  await stop();
}
