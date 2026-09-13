import { createHash } from 'node:crypto';
import nodeFS from 'node:fs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
// Electron's patched fs exposes app.asar as a virtual directory. Hash the actual
// archive bytes, so the Node verifier and Electron controller share one baseline.
const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFS;
const readdir = promisify(fs.readdir);
const lstat = promisify(fs.lstat);
const readlink = promisify(fs.readlink);

export async function signature(bundle) {
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const { stderr } = await exec('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  const cdhash = stderr.match(/^CDHash=(.+)$/m)?.[1];
  if (!cdhash) throw new Error('Could not read fixture code signature hash.');
  return { valid: true, cdhash, hardenedRuntime: /flags=.*runtime/.test(stderr), adHoc: /Signature=adhoc/.test(stderr) };
}

export async function fingerprint(bundle) {
  const aggregate = createHash('sha256');
  let files = 0;
  async function visit(relative) {
    const full = path.join(bundle, relative);
    const stat = await lstat(full);
    aggregate.update(JSON.stringify([relative, stat.mode]));
    if (stat.isSymbolicLink()) {
      aggregate.update(`link:${await readlink(full)}`);
    } else if (stat.isDirectory()) {
      for (const name of (await readdir(full)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(full)) hash.update(chunk);
      aggregate.update(hash.digest());
      files++;
    } else throw new Error(`Unexpected bundle entry: ${relative}`);
  }
  await visit('');
  return { sha256: aggregate.digest('hex'), files };
}

export async function inspectIntegrity(bundle) {
  const [signed, content] = await Promise.all([signature(bundle), fingerprint(bundle)]);
  return { ...signed, ...content };
}

export function compareIntegrity(before, after) {
  const unchanged = before.sha256 === after.sha256 && before.cdhash === after.cdhash && after.valid;
  if (!unchanged) throw new Error('Fixture bundle or signature changed.');
  return { unchanged, before, after };
}
