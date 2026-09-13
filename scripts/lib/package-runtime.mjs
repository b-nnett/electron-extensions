import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BROKERS = Object.freeze(['dock-fixture-session.mjs', 'dock-chatgpt-session.mjs', 'dock-catalog-session.mjs', 'dock-claude-session.mjs']);

// Build-time staging only. No package installation, target app access or launch.
// Keep the runtime dependency closure separate from checkout/output/user data.
export function packageRuntime({ root, resources, appLaunchHelper, processIdentityHelper, nodeExecutable, nodeLicense }) {
  root = realpathSync(root);
  mkdirSync(resources, { recursive: true });
  resources = realpathSync(resources);
  const staging = mkdtempSync(path.join(resources, '.runtime-'));
  chmodSync(staging, 0o755);
  let files = 0, bytes = 0;
  const copy = (source, relative) => {
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(source) !== path.resolve(source)) {
      throw new Error(`Runtime source must be a regular, unlinked file: ${relative}`);
    }
    files += 1; bytes += stat.size;
    if (files > 511 || bytes > 256 * 1024 * 1024 - 1024) throw new Error('Packaged runtime exceeds its file or size limit');
    const destination = path.join(staging, relative);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    copyFileSync(source, destination);
    chmodSync(destination, stat.mode & 0o777);
  };
  const directory = (source, relative, depth = 0) => {
    const stat = lstatSync(source);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(source) !== path.resolve(source) || depth > 8) {
      throw new Error(`Invalid runtime source directory: ${relative}`);
    }
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(source, entry.name), target = path.join(relative, entry.name);
      if (entry.isDirectory()) directory(child, target, depth + 1);
      else copy(child, target);
    }
  };
  try {
    for (const filename of BROKERS) copy(path.join(root, 'scripts', filename), `scripts/${filename}`);
    for (const filename of readdirSync(path.join(root, 'lib')).sort()) {
      if (filename.endsWith('.mjs')) copy(path.join(root, 'lib', filename), `lib/${filename}`);
    }
    directory(path.join(root, 'node_modules', 'ws'), 'node_modules/ws');
    for (const filename of ['button-demo.css', 'button-demo.js']) copy(path.join(root, 'extensions', filename), `extensions/${filename}`);
    for (const relative of ['compatibility/runtime-profiles.json', 'native/runtime-profiles.json']) {
      copy(path.join(root, 'compatibility', 'runtime-profiles.json'), relative);
    }
    copy(realpathSync(appLaunchHelper), 'native/CatalogAppLaunch');
    if (processIdentityHelper) copy(realpathSync(processIdentityHelper), 'native/ProcessIdentity');
    if (nodeExecutable) copy(realpathSync(nodeExecutable), 'native/node');
    if (nodeLicense) copy(realpathSync(nodeLicense), 'native/Node-LICENSE');
    writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'extensions-anywhere-runtime', private: true, type: 'module' }, null, 2), { mode: 0o644 });
    const destination = path.join(resources, 'Runtime');
    const backup = `${staging}-previous`;
    let hadPrevious = false;
    try { lstatSync(destination); hadPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (hadPrevious) renameSync(destination, backup);
    try { renameSync(staging, destination); }
    catch (error) { if (hadPrevious) renameSync(backup, destination); throw error; }
    if (hadPrevious) rmSync(backup, { recursive: true });
    return { runtimeRoot: destination, files: files + 1, bytes };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
