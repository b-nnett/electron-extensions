import test from 'node:test';
import assert from 'node:assert/strict';
import { NODE_VERSION, validateNodeArchive, systemLibraryDependencies } from '../scripts/lib/bundled-node.mjs';

test('bundled Node rejects altered or unsupported distribution archives', () => {
  assert.match(NODE_VERSION, /^24\./);
  assert.throws(() => validateNodeArchive(Buffer.from('modified'), 'arm64'), /checksum/);
  assert.throws(() => validateNodeArchive(Buffer.from('modified'), 'x64'), /checksum/);
  assert.throws(() => validateNodeArchive(Buffer.alloc(0), 'unknown'), /architecture/);
});
test('runtime dependency audit rejects Homebrew and external dynamic libraries', () => {
  const sample = dependencies => 'node:\n' + dependencies.map(file => `\t${file} (compatibility version 1.0.0, current version 1.0.0)`).join('\n');
  const system = ['/usr/lib/libSystem.B.dylib', '/System/Library/Frameworks/Security.framework/Versions/A/Security'];
  assert.deepEqual(systemLibraryDependencies(sample(system)), system);
  for (const external of ['/opt/homebrew/lib/libnode.dylib', '/usr/local/lib/libssl.dylib', '@rpath/libnode.dylib']) {
    assert.throws(() => systemLibraryDependencies(sample([...system, external])), /system libraries/);
  }
  assert.throws(() => systemLibraryDependencies('node:'), /system libraries/);
});
