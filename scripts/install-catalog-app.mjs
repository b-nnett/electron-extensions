// One catalogued app per invocation. Never replaces or deletes an installed app.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compareIntegrity, inspectIntegrity } from '../lib/integrity.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RESERVE_BYTES = 8 * 1024 ** 3;
const COPY_OVERHEAD = 64 * 1024 ** 2;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const within = (parent, child) => child.startsWith(parent + path.sep);

// Only answer hdiutil's ordinary license question; other commands get EOF.
// Acceptance of installer terms was explicitly authorized for this installation run.
export async function runInstallerCommand(file, args, options = {}, onLicenseAccepted) {
  const { timeout, signal, input, ...execOptions } = options;
  const signals = [signal, timeout ? AbortSignal.timeout(timeout) : undefined].filter(Boolean);
  const pending = exec(file, args, { ...execOptions, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
  const child = pending.child;
  child.stdin.on('error', () => {}); // The command may exit before consuming stdin.
  if (input !== undefined) child.stdin.end(input);
  else if (!onLicenseAccepted) child.stdin.end();
  else {
    let tail = '', answered = false;
    const observe = chunk => {
      tail = (tail + chunk).slice(-8192);
      const prompt = tail.match(/(?:Do you agree to the terms of (?:the |this )?license(?: agreement)?\?\s*(?:\[y\/n\]|\(y\/n\))\s*:?|Agree Y\/N\?\s*)/i);
      if (prompt && !answered) {
        answered = true;
        onLicenseAccepted(prompt[0]);
        child.stdin.end('Y\n');
      }
    };
    child.stdout.on('data', observe); child.stderr.on('data', observe);
  }
  try { return await pending; }
  catch (error) {
    // AbortError may arrive before execFile's child exits. Reap that owned child
    // before cleaning staging; hdiutil can otherwise remain at an input prompt.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.stdin.end(); child.kill('SIGTERM');
      });
    }
    throw error;
  }
}

export function validateDestination(bundle) {
  if (typeof bundle !== 'string' || path.dirname(bundle) !== '/Applications' || bundle !== path.join('/Applications', path.basename(bundle)) ||
      !/^[^./\\\x00-\x1f][^/\\\x00-\x1f]*\.app$/.test(path.basename(bundle))) {
    throw new Error('Destination must be one named .app directly inside /Applications.');
  }
  return bundle;
}

export function validateInstall(entry) {
  const bundle = validateDestination(entry.bundlePath);
  const spec = entry.install;
  if (!spec || !['dmg', 'zip'].includes(spec.type) || spec.appName !== path.basename(bundle)) {
    throw new Error('Catalog needs a matching appName and a dmg or zip installation recipe.');
  }
  const url = new URL(spec.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Installer URL must be HTTPS without credentials or a fragment.');
  if (spec.sha256 !== null && !/^[a-f0-9]{64}$/i.test(spec.sha256 ?? '')) throw new Error('Expected sha256 must be 64 hex digits or explicit null.');
  if (spec.estimatedCompressedBytes != null && (!Number.isSafeInteger(spec.estimatedCompressedBytes) || spec.estimatedCompressedBytes < 0)) {
    throw new Error('Invalid estimated installer size.');
  }
  return { ...spec, url: url.href, sha256: spec.sha256?.toLowerCase() ?? null, bundle };
}

export function requireCapacity(available, additional, phase) {
  if (!Number.isFinite(available) || !Number.isFinite(additional) || additional < 0 || available - additional < RESERVE_BYTES) {
    throw new Error(`Insufficient disk space for ${phase}; retain at least 8 GiB after the planned allocation.`);
  }
}

async function freeBytes(folder) {
  const info = await statfs(folder);
  return info.bavail * info.bsize;
}

async function bundleBytes(folder) {
  let bytes = 0;
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, item.name);
    if (item.isDirectory()) bytes += await bundleBytes(file);
    else if (item.isFile()) bytes += (await lstat(file)).size;
  }
  return bytes;
}

async function findApps(folder, appName, depth = 0) {
  const found = [];
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (!item.isDirectory() || item.name === '__MACOSX') continue;
    const child = path.join(folder, item.name);
    if (item.name === appName) found.push(child);
    else if (!item.name.endsWith('.app') && depth < 4) found.push(...await findApps(child, appName, depth + 1));
  }
  return found;
}

// Inspect only ZIP metadata and symlink payloads. ditto performs the extraction.
// Validate symlink chains as well as member names before writing any ZIP entries.
const ZIP_PREFLIGHT = String.raw`
import json, posixpath, stat, sys, unicodedata, zipfile
def canonical(name):
    return unicodedata.normalize('NFD', posixpath.normpath(name)).casefold()
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    links, names = {}, set()
    for item in entries:
        name = item.filename.rstrip('/')
        parts = name.split('/')
        if not name or name.startswith('/') or '\\' in name or '..' in parts or any(ord(c) < 32 for c in name):
            raise ValueError('Unsupported ZIP member path')
        name = canonical(name)
        if name in names:
            raise ValueError('Duplicate ZIP member path')
        names.add(name)
        mode = item.external_attr >> 16
        if stat.S_ISLNK(mode):
            if item.file_size > 4096:
                raise ValueError('Oversized ZIP symlink')
            target = archive.read(item).decode('utf-8')
            if target.startswith('/') or '\\' in target or any(ord(c) < 32 for c in target):
                raise ValueError('Unsupported ZIP symlink target')
            links[name] = unicodedata.normalize('NFD', target).casefold()
        elif stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError('Unsupported special ZIP member')
    for name in names:
        pending, resolved, hops = name.split('/'), [], 0
        while pending:
            part = pending.pop(0)
            if part in ('', '.'):
                continue
            if part == '..':
                if not resolved:
                    raise ValueError('ZIP symlink escapes extraction root')
                resolved.pop()
                continue
            candidate = '/'.join(resolved + [part])
            if candidate in links:
                hops += 1
                if hops > 40:
                    raise ValueError('Cyclic or excessive ZIP symlink chain')
                pending = links[candidate].split('/') + pending
            else:
                resolved.append(part)
    print(json.dumps({'uncompressedBytes': sum(i.file_size for i in entries), 'entries': len(entries)}))
`;

export async function inspectZipMetadata(archive, run = exec) {
  const { stdout } = await run('/usr/bin/python3', ['-c', ZIP_PREFLIGHT, archive]);
  return JSON.parse(stdout);
}

export async function installCatalogApp(slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug ?? '')) throw new Error('Supply one catalog slug.');
  const reportFolder = path.join(root, 'output', 'installations', slug);
  await mkdir(reportFolder, { recursive: true });
  const reportPath = path.join(reportFolder, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  const report = { slug, startedAt: new Date().toISOString(), status: 'starting', errors: [] };
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Installation interrupted.'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const run = (file, args) => runInstallerCommand(file, args, { signal: abort.signal, maxBuffer: 8 * 1024 ** 2, timeout: 15 * 60 * 1000 });
  let staging, mountRoot;
  const mounted = new Set();
  try {
    const catalog = JSON.parse(await readFile(path.join(root, 'compatibility', 'apps.json'), 'utf8'));
    if (!Array.isArray(catalog)) throw new Error('Catalog must be a top-level array.');
    const matches = catalog.filter(item => item.slug === slug);
    if (matches.length !== 1) throw new Error('Slug must match exactly one catalog entry.');
    const entry = matches[0];
    report.bundle = validateDestination(entry.bundlePath);
    if (await exists(report.bundle)) { report.status = 'already-installed'; return report; }
    const spec = validateInstall(entry);
    report.install = spec;
    staging = await realpath(await mkdtemp(path.join(tmpdir(), `extensions-anywhere-install-${slug}-`)));
    const available = Math.min(await freeBytes(staging), await freeBytes('/Applications'));
    const maxDownloadBytes = Math.floor((available - RESERVE_BYTES) / 2);
    requireCapacity(available, Math.max(spec.estimatedCompressedBytes ?? 0, 64 * 1024 ** 2) * 2, 'installer download and staging');
    const archive = path.join(staging, `installer.${spec.type}`);
    report.status = 'downloading'; await save();
    await run('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '30', '--max-time', '900', '--max-filesize', String(maxDownloadBytes), '--output', archive, '--url', spec.url]);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) { abort.signal.throwIfAborted(); hash.update(chunk); }
    report.download = { bytes: (await lstat(archive)).size, sha256: hash.digest('hex'), expectedHashMatched: spec.sha256 ? undefined : null };
    if (spec.sha256) {
      report.download.expectedHashMatched = report.download.sha256 === spec.sha256;
      if (!report.download.expectedHashMatched) throw new Error('Downloaded installer SHA-256 does not match the catalog.');
    }
    report.status = 'inspecting-source'; await save();
    let sourceRoot;
    if (spec.type === 'zip') {
      report.zip = await inspectZipMetadata(archive, run);
      requireCapacity(await freeBytes(staging), report.zip.uncompressedBytes + COPY_OVERHEAD, 'ZIP extraction');
      sourceRoot = path.join(staging, 'extracted'); await mkdir(sourceRoot);
      await run('/usr/bin/ditto', ['-x', '-k', archive, sourceRoot]);
    } else {
      mountRoot = path.join(staging, 'mounts'); await mkdir(mountRoot);
      report.diskImageLicenseResponse = { userAuthorized: true, supplied: 'Y' };
      const { stdout } = await runInstallerCommand('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-plist', '-mountroot', mountRoot, archive],
        { signal: abort.signal, maxBuffer: 8 * 1024 ** 2, timeout: 120000, input: 'Y\n' });
      const xmlStart = stdout.indexOf('<?xml');
      if (xmlStart < 0) throw new Error('Disk image attach did not return a plist.');
      const plist = path.join(staging, 'mount.plist'); await writeFile(plist, stdout.slice(xmlStart));
      const parsed = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout);
      for (const entity of parsed['system-entities'] ?? []) {
        const point = entity['mount-point'];
        if (!point) continue;
        if (!within(mountRoot, point)) throw new Error('Disk image mounted outside the owned mount directory.');
        mounted.add(point);
      }
      if (!mounted.size) throw new Error('Disk image contains no mounted filesystem.');
      sourceRoot = mountRoot;
    }
    const sources = await findApps(sourceRoot, spec.appName);
    if (sources.length !== 1) throw new Error('Installer must contain exactly one app with the catalogued appName.');
    const source = sources[0];
    report.source = { path: source, bytes: await bundleBytes(source) };
    report.source.integrity = await inspectIntegrity(source);
    const infoPath = path.join(source, 'Contents', 'Info.plist');
    if (!within(source, await realpath(infoPath))) throw new Error('Bundle metadata resolves outside its app.');
    const info = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath])).stdout);
    const executableName = info.CFBundleExecutable;
    if (typeof executableName !== 'string' || !executableName || path.basename(executableName) !== executableName || /[\\\x00-\x1f]/.test(executableName) || ['.', '..'].includes(executableName)) throw new Error('Invalid main executable metadata.');
    const executable = path.join(source, 'Contents', 'MacOS', executableName);
    const framework = path.join(source, 'Contents', 'Frameworks', 'Electron Framework.framework');
    if (!within(source, await realpath(executable)) || !within(source, await realpath(framework)) || !(await lstat(await realpath(framework))).isDirectory()) throw new Error('A contained Electron framework and main executable are required.');
    const frameworkInfoPath = path.join(framework, 'Resources', 'Info.plist');
    if (!within(source, await realpath(frameworkInfoPath))) throw new Error('Electron metadata resolves outside its app.');
    const frameworkInfo = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', frameworkInfoPath])).stdout);
    const architectures = (await run('/usr/bin/lipo', ['-archs', executable])).stdout.trim().split(/\s+/);
    if (!architectures.includes('arm64')) throw new Error('Main executable must support arm64 natively.');
    report.source.metadata = { id: info.CFBundleIdentifier, version: info.CFBundleShortVersionString, build: info.CFBundleVersion, executableName, architectures,
      electronFramework: true, electronVersion: frameworkInfo.CFBundleVersion ?? frameworkInfo.CFBundleShortVersionString ?? null, electronIdentifier: frameworkInfo.CFBundleIdentifier };
    requireCapacity(await freeBytes('/Applications'), report.source.bytes + COPY_OVERHEAD, 'app copy');
    abort.signal.throwIfAborted();
    // Atomic reservation prevents ditto from merging into a pre-existing app.
    try { await mkdir(report.bundle); }
    catch (error) { if (error.code !== 'EEXIST') throw error; report.status = 'already-installed'; return report; }
    report.targetCreated = true;
    report.status = 'copying'; await save();
    await run('/usr/bin/ditto', [source, report.bundle]);
    report.installed = await inspectIntegrity(report.bundle);
    report.unchanged = compareIntegrity(report.source.integrity, report.installed).unchanged;
    report.status = 'installed';
    return report;
  } catch (error) {
    report.status = 'failed'; report.errors.push(String(error.message ?? error).slice(0, 3000));
    report.targetRetained = Boolean(report.targetCreated);
    return report;
  } finally {
    // Recover owned mounts even if hdiutil or plist parsing was interrupted.
    if (mountRoot) for (const name of await readdir(mountRoot).catch(() => [])) mounted.add(path.join(mountRoot, name));
    let detached = true;
    for (const point of mounted) {
      let failure;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await exec('/usr/bin/hdiutil', ['detach', point], { timeout: 30000 }); failure = null; break; }
        catch (error) { failure = error; await delay(300); }
      }
      if (failure) { detached = false; report.errors.push(`Owned mount retained: ${point}: ${failure.message}`); }
    }
    if (staging && detached) {
      try { await rm(staging, { recursive: true, force: true }); report.stagingRemoved = true; }
      catch (error) { report.errors.push(`Staging cleanup: ${error.message}`); }
    } else if (staging) report.retainedStaging = staging;
    report.finishedAt = new Date().toISOString();
    report.reportPath = reportPath;
    try { await save(); }
    finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/install-catalog-app.mjs <slug>');
  const report = await installCatalogApp(process.argv[2]);
  console.log(JSON.stringify({ status: report.status, bundle: report.bundle, reportPath: report.reportPath, errors: report.errors }));
  if (report.status === 'failed' || report.errors.length) process.exitCode = 1;
}
