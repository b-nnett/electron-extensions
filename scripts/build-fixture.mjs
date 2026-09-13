import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('This proof targets macOS.');
const [folder] = await packager({
  dir: path.join(root, 'fixture'), out: path.join(root, 'dist'),
  name: 'Style Lab', appBundleId: 'dev.extensionsanywhere.stylelab',
  executableName: 'Style Lab', platform: 'darwin', arch: process.arch,
  electronVersion: '44.2.0', overwrite: true, asar: true,
  prune: false
});
const bundle = path.join(folder, 'Style Lab.app');
// Only OUR fixture is signed, once, at build time. Runtime code never signs apps.
execFileSync('/usr/bin/codesign', [
  '--force', '--deep', '--sign', '-', '--options', 'runtime',
  '--entitlements', path.join(root, 'scripts/entitlements.plist'), bundle
], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
console.log(`Built and ad-hoc signed with Hardened Runtime: ${bundle}`);
