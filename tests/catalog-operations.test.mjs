import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sampleCatalogSurvival, appendCatalogRevision } from '../scripts/dock-catalog-session.mjs';
import { readBoundedJSON } from '../lib/catalog-stylesheet.mjs';

const run = promisify(execFile);
const identity = { pid: 123, started: '123456.123456', uid: 501, executable: '/Applications/Owned.app/Contents/MacOS/Owned' };

test('final survival samples the kernel after final work and an exit during the read overrides an alive result', async () => {
  let exited = false, reads = 0;
  const sample = await sampleCatalogSurvival(identity, { readIdentity: async pid => {
    reads++; assert.equal(pid, identity.pid); exited = true; return identity;
  }, hasExited: () => exited, clock: () => 'observation-after-integrity' });
  assert.equal(reads, 1);
  assert.equal(sample.sameProcessAlive, false);
  assert.equal(sample.observedAt, 'observation-after-integrity');
  assert.equal(sample.reason, 'observed-original-process-exit');
  // A callback already observed while the final bundle fingerprint ran still
  // causes a fresh kernel sample, rather than a cached pre-fingerprint result.
  await sampleCatalogSurvival(identity, { hasExited: () => true,
    readIdentity: async () => { reads++; return null; } });
  assert.equal(reads, 2);
});

test('final survival distinguishes exact live identity, confirmed exit or reuse, and uncertain ownership', async () => {
  for (const [current, expected] of [[identity, true], [null, false],
    [{ ...identity, started: '123456.123457' }, false], [{ ...identity, executable: '/other' }, null]]) {
    assert.equal((await sampleCatalogSurvival(identity, { readIdentity: async () => current })).sameProcessAlive, expected);
  }
  const failed = await sampleCatalogSurvival(identity, { readIdentity: async () => { throw new Error('reader unavailable'); } });
  assert.equal(failed.sameProcessAlive, null); assert.equal(failed.reason, 'identity-unresolved');
});

test('catalog evidence rolls to 64 entries while revision identity and later restore references remain monotonic', () => {
  const report = { revisions: [], revisionCount: 0, droppedRevisions: 0 };
  let latest;
  for (let number = 1; number <= 150; number++) {
    latest = appendCatalogRevision(report, { marker: number });
    assert.equal(latest.number, number);
    assert.ok(report.revisions.length <= 64);
  }
  assert.equal(report.revisionCount, 150); assert.equal(report.droppedRevisions, 86);
  assert.deepEqual(report.revisions.map(entry => entry.number), Array.from({ length: 64 }, (_, i) => i + 87));
  latest.restoration = { stylesheetReadbackVerified: true };
  assert.equal(report.revisions.at(-1).restoration.stylesheetReadbackVerified, true);
});

test('bounded JSON rejects symlink and FIFO inputs without waiting for a writer', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ea-catalog-json-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const regular = path.join(directory, 'regular.json'), alias = path.join(directory, 'alias.json'), fifo = path.join(directory, 'fifo.json');
  await writeFile(regular, '{"records":[]}'); await symlink(regular, alias);
  assert.deepEqual(await readBoundedJSON(regular, 1024), { records: [] });
  await assert.rejects(readBoundedJSON(alias, 1024));
  await run('/usr/bin/mkfifo', [fifo]);
  const module = new URL('../lib/catalog-stylesheet.mjs', import.meta.url).href;
  const code = `import {readBoundedJSON} from ${JSON.stringify(module)};
    try { await readBoundedJSON(process.argv[1], 1024); process.exitCode=2; }
    catch(error) { if(!/regular JSON file/.test(error.message)) throw error; }`;
  // Isolated child provides a hard timeout even for a regression to blocking
  // open(), without leaving a blocked filesystem worker in the test process.
  await run(process.execPath, ['--input-type=module', '-e', code, fifo], { timeout: 2000 });
});
