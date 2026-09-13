import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROKERS, packageRuntime } from '../scripts/lib/package-runtime.mjs';

function fixture(t) {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ea-runtime-test-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'Documents', 'checkout'), resources = path.join(temporary, 'Library', 'Example Launcher.app', 'Contents', 'Resources');
  const write = (relative, content) => {
    const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); return file;
  };
  for (const file of BROKERS) write(`scripts/${file}`, "import { value } from '../lib/module.mjs'; import ws from 'ws'; console.log(value + ws);\n");
  write('lib/module.mjs', 'export const value = 20;\n');
  write('lib/not-runtime.txt', 'do not copy');
  write('node_modules/ws/package.json', '{"name":"ws","type":"module","exports":"./index.js"}');
  write('node_modules/ws/index.js', 'export default 22;\n');
  write('extensions/button-demo.css', 'button {}'); write('extensions/button-demo.js', '/* bundled fixture source */');
  write('compatibility/runtime-profiles.json', '[]');
  const appLaunchHelper = write('build/CatalogAppLaunch', 'owned native test artifact'); chmodSync(appLaunchHelper, 0o755);
  write('output/private.json', 'not packaged');
  return { temporary, root, resources, appLaunchHelper, write };
}

test('packaged broker dependencies execute after the entire checkout moves away', t => {
  const f = fixture(t), result = packageRuntime(f);
  renameSync(f.root, `${f.root}-unavailable`);
  for (const broker of BROKERS) {
    const output = execFileSync(process.execPath, [path.join(result.runtimeRoot, 'scripts', broker)], {
      cwd: result.runtimeRoot, encoding: 'utf8', env: { PATH: process.env.PATH },
    });
    assert.equal(output.trim(), '42');
  }
  assert.equal(statSync(path.join(result.runtimeRoot, 'native/CatalogAppLaunch')).mode & 0o777, 0o755);
  assert.equal(readFileSync(path.join(result.runtimeRoot, 'native/runtime-profiles.json'), 'utf8'), '[]');
  assert.equal(existsSync(path.join(result.runtimeRoot, 'lib/not-runtime.txt')), false);
  assert.equal(existsSync(path.join(result.runtimeRoot, 'output')), false);
});

test('failed package staging preserves the previous complete runtime', t => {
  const f = fixture(t), first = packageRuntime(f);
  f.write('lib/module.mjs', 'export const value = 999;\n');
  symlinkSync(path.join(f.root, 'output/private.json'), path.join(f.root, 'lib/linked.mjs'));
  assert.throws(() => packageRuntime(f), /regular, unlinked/);
  assert.equal(readFileSync(path.join(first.runtimeRoot, 'lib/module.mjs'), 'utf8'), 'export const value = 20;\n');
});

test('fresh staging replaces obsolete owned runtime files and copies new local modules', t => {
  const f = fixture(t), first = packageRuntime(f);
  writeFileSync(path.join(first.runtimeRoot, 'obsolete.mjs'), 'old');
  f.write('lib/owned-local-service.mjs', 'export const fixed = true;\n');
  const next = packageRuntime(f);
  assert.equal(existsSync(path.join(next.runtimeRoot, 'obsolete.mjs')), false);
  assert.equal(readFileSync(path.join(next.runtimeRoot, 'lib/owned-local-service.mjs'), 'utf8'), 'export const fixed = true;\n');
});

test('native runtime and license are copied into relocatable resources with executable modes', t => {
  const f = fixture(t);
  const nodeExecutable = f.write('verified-node/bin/node', 'signed-node-fixture');
  const processIdentityHelper = f.write('build/ProcessIdentity', 'signed-process-reader-fixture');
  const nodeLicense = f.write('verified-node/LICENSE', 'official-node-license-fixture');
  chmodSync(nodeExecutable, 0o755); chmodSync(processIdentityHelper, 0o755);
  const { runtimeRoot } = packageRuntime({ ...f, nodeExecutable, processIdentityHelper, nodeLicense });
  renameSync(f.root, `${f.root}-unavailable`);
  const relocated = path.join(f.temporary, 'Relocated Runtime');
  renameSync(runtimeRoot, relocated);
  for (const [name, content] of [['node', 'signed-node-fixture'], ['ProcessIdentity', 'signed-process-reader-fixture']]) {
    const file = path.join(relocated, 'native', name);
    assert.equal(readFileSync(file, 'utf8'), content);
    assert.equal(statSync(file).mode & 0o777, 0o755);
  }
  assert.equal(readFileSync(path.join(relocated, 'native/Node-LICENSE'), 'utf8'), 'official-node-license-fixture');
});

test('real broker module graphs load solely from packaged resources without starting a session', t => {
  const f = fixture(t);
  const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { runtimeRoot } = packageRuntime({ ...f, root });
  // Import guards are deliberately false in node -e: no app inventory, launch,
  // debugger, library or Dock operation runs. This verifies the real ws/local
  // module closure, including modules added after the packager was written.
  const code = `for (const file of ${JSON.stringify(BROKERS)}) await import(new URL('./scripts/' + file, 'file://' + process.cwd() + '/')); console.log('all module graphs loaded');`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: runtimeRoot, encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.equal(output.trim(), 'all module graphs loaded');
});
