import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Official LTS release, hashes from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.
export const NODE_VERSION = '24.21.0';
export const NODE_ARCHIVES = Object.freeze({
  arm64: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  x64: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
});

export function validateNodeArchive(bytes, architecture) {
  const expected = NODE_ARCHIVES[architecture];
  if (!expected) throw new Error(`Unsupported Node architecture: ${architecture}`);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Official Node archive checksum does not match the pinned release.');
}

export function systemLibraryDependencies(output) {
  const dependencies = output.split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
  if (!dependencies.length || dependencies.some(file => !file.startsWith('/usr/lib/') && !file.startsWith('/System/Library/'))) {
    throw new Error('Bundled Node must depend only on macOS system libraries.');
  }
  return dependencies;
}

export async function prepareBundledNode({ cacheRoot, architecture = process.arch }) {
  if (!NODE_ARCHIVES[architecture]) throw new Error(`Unsupported Node architecture: ${architecture}`);
  const name = `node-v${NODE_VERSION}-darwin-${architecture}`;
  mkdirSync(cacheRoot, { recursive: true });
  const archive = path.join(cacheRoot, `${name}.tar.gz`);
  if (!existsSync(archive)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`;
    console.log(`Downloading official Node ${NODE_VERSION} (${architecture})`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    validateNodeArchive(bytes, architecture);
    const temporaryArchive = `${archive}.${process.pid}.partial`;
    writeFileSync(temporaryArchive, bytes, { flag: 'wx', mode: 0o644 });
    renameSync(temporaryArchive, archive);
  }
  // Re-check cached bytes; an existing cache is not a trust decision.
  validateNodeArchive(readFileSync(archive), architecture);
  const staging = mkdtempSync(path.join(cacheRoot, '.node-'));
  try {
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', staging, `${name}/bin/node`, `${name}/LICENSE`]);
    const executable = path.join(staging, name, 'bin', 'node');
    const dependencies = systemLibraryDependencies(execFileSync('/usr/bin/otool', ['-L', executable], { encoding: 'utf8' }));
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim();
    if (version !== `v${NODE_VERSION}`) throw new Error('Bundled Node version mismatch.');
    const destination = path.join(cacheRoot, `${name}-verified`);
    // This is disposable build cache; never an installed user runtime.
    rmSync(destination, { recursive: true, force: true });
    renameSync(path.join(staging, name), destination);
    return { executable: path.join(destination, 'bin', 'node'), license: path.join(destination, 'LICENSE'),
      version: NODE_VERSION, architecture, archiveSHA256: NODE_ARCHIVES[architecture], dependencies };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
