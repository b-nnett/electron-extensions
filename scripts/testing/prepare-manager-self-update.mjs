import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Test-only preparation of OUR manager. Never launches any app, changes user
// defaults/library, exports a private key, uploads release assets, or edits latest.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceBase = path.join(repository, 'output/release-review/2026-09-13');
const supportBase = path.join(os.homedir(), 'Library/Application Support/Extensions Anywhere Native E2E');
const source = path.join(evidenceBase, 'notarization/build-3/Extensions Anywhere.app');
const productionFeed = 'https://github.com/b-nnett/electron-extensions/releases/latest/download/appcast.xml';
const testFeed = 'https://github.com/b-nnett/electron-extensions/releases/download/updater-e2e-20260913/appcast.xml';
const publicKey = 'sek+Mp0TedaOAi0QoQA1luAcjgXWnXDQW6pbjnCVyy8=';
const identity = 'Developer ID Application: Nyne Apps LTD. (X522N436T7)';
const finishing = process.argv[2] === '--finish';
const submitting = process.argv[2] === '--submit';
const resuming = finishing || submitting;
assert.ok(resuming ? process.argv.length === 4 : process.argv.length === 2, 'Usage: node prepare-manager-self-update.mjs [--submit RUN_UUID | --finish RUN_UUID]');
const runID = resuming ? process.argv[3] : randomUUID();
assert.match(runID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const name = `manager-self-update-${runID}`;
const evidence = path.join(evidenceBase, name);
const live = path.join(supportBase, name);
const app = path.join(live, 'Host/Extensions Anywhere.app');
const archive = path.join(evidence, 'lower-build-3-notarization.zip');
let commandNumber = resuming ? Math.max(0, ...readdirSync(evidence).map(name => Number(name.match(/^command-(\d+)\.log$/)?.[1] || 0))) : 0;

function exactDirectory(directory) {
  assert.equal(realpathSync(directory), directory, 'Test directories cannot be symlink aliases.');
  assert.ok(lstatSync(directory).isDirectory());
}
function save(filename, value) {
  writeFileSync(path.join(evidence, filename), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
function command(executable, args) {
  const number = ++commandNumber;
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(path.join(evidence, `command-${number}.log`), (result.stdout || '') + (result.stderr || ''), { mode: 0o600, flag: 'wx' });
  assert.equal(result.status, 0, `Preparation command ${number} failed; inspect its saved log. ${result.error?.message || ''}`);
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
}
function info(bundle) {
  return JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')]).stdout);
}
function validateInfo(value, feed) {
  assert.equal(value.CFBundleIdentifier, 'dev.extensions-anywhere.app');
  assert.equal(value.CFBundleShortVersionString, '0.1.2');
  assert.equal(value.CFBundleVersion, '3');
  assert.equal(value.SUFeedURL, feed);
  assert.equal(value.SUPublicEDKey, publicKey);
  assert.equal(value.SURequireSignedFeed, true);
  assert.equal(value.SUVerifyUpdateBeforeExtraction, true);
}
function sha256(filename) { return createHash('sha256').update(readFileSync(filename)).digest('hex'); }
function treeDigest(directory) {
  const entries = [];
  function visit(relative) {
    const filename = path.join(directory, relative), stat = lstatSync(filename);
    if (stat.isSymbolicLink()) entries.push([relative, 'symlink', readlinkSync(filename)]);
    else if (stat.isDirectory()) for (const child of readdirSync(filename).sort()) visit(path.join(relative, child));
    else { assert.ok(stat.isFile()); entries.push([relative, 'file', stat.mode & 0o777, sha256(filename)]); }
  }
  visit('');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
function signature(bundle) {
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const value = command('/usr/bin/codesign', ['--display', '--verbose=4', bundle]).stderr;
  assert.match(value, /^TeamIdentifier=X522N436T7$/m);
  assert.match(value, /flags=0x10000\(runtime\)/);
  const cdhash = value.match(/^CDHash=([0-9a-f]+)$/m)?.[1];
  assert.ok(cdhash);
  return { cdhash, team: 'X522N436T7', developerID: true, hardenedRuntime: true,
    executableSHA256: sha256(path.join(bundle, 'Contents/MacOS/ExtensionsAnywhere')), bundleTreeSHA256: treeDigest(bundle) };
}
function submit() {
  assert.ok(!existsSync(path.join(evidence, 'notary-submission.json')), 'This run already has a notary submission; use --finish.');
  const response = JSON.parse(command('/usr/bin/xcrun', ['notarytool', 'submit', archive,
    '--keychain-profile', 'nyneapps', '--output-format', 'json']).stdout);
  assert.match(response.id || '', /^[0-9a-f-]{36}$/i);
  save('notary-submission.json', { ...response, archiveSHA256: sha256(archive) });
  console.log(JSON.stringify({ runID, app, evidence, submissionID: response.id, next: `node scripts/testing/prepare-manager-self-update.mjs --finish ${runID}` }, null, 2));
}

if (!resuming) {
  exactDirectory(evidenceBase);
  exactDirectory(path.dirname(supportBase));
  if (!existsSync(supportBase)) mkdirSync(supportBase, { mode: 0o700 });
  exactDirectory(supportBase);
  assert.ok(!existsSync(evidence) && !existsSync(live), 'A prior run must not be overwritten.');
  mkdirSync(evidence, { mode: 0o700 });
  mkdirSync(live, { mode: 0o700 });
  mkdirSync(path.dirname(app), { mode: 0o700 });
  exactDirectory(source);
  console.log(`Preparing lower real manager: ${app}`);
  const sourceInfo = info(source);
  validateInfo(sourceInfo, productionFeed);
  const original = signature(source);
  const resourcesDigest = treeDigest(path.join(source, 'Contents/Resources'));
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', source]);
  command('/usr/bin/ditto', [source, app]);
  assert.equal(treeDigest(app), original.bundleTreeSHA256);
  command('/usr/bin/plutil', ['-replace', 'SUFeedURL', '-string', testFeed, path.join(app, 'Contents/Info.plist')]);
  const changedInfo = info(app);
  validateInfo(changedInfo, testFeed);
  assert.deepEqual({ ...changedInfo, SUFeedURL: productionFeed }, sourceInfo, 'Only the copied Info.plist feed may change.');
  command('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', app]);
  const lower = signature(app);
  assert.equal(treeDigest(path.join(app, 'Contents/Resources')), resourcesDigest);
  assert.equal(treeDigest(source), original.bundleTreeSHA256);
  const receipt = { schema: 1, runID, phase: 'signed-lower-prepared', createdAt: new Date().toISOString(),
    source, evidence, live, app, archive, sourceInfo, original, lower, testFeed,
    changes: ['SUFeedURL in our copied Info.plist', 'our copied outer Developer ID signature'],
    untouched: ['frozen build 3', 'production feed', 'user preferences', 'extension library', 'third-party applications'],
    launched: false, published: false };
  save('preparation.json', receipt);
  writeFileSync(path.join(live, 'test-run-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  command('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  submit();
} else {
  exactDirectory(evidence); exactDirectory(live); exactDirectory(app);
  const receipt = JSON.parse(readFileSync(path.join(evidence, 'preparation.json'), 'utf8'));
  assert.deepEqual(receipt, JSON.parse(readFileSync(path.join(live, 'test-run-receipt.json'), 'utf8')));
  assert.equal(receipt.runID, runID); assert.equal(receipt.app, app); assert.equal(receipt.source, source);
  assert.equal(receipt.testFeed, testFeed); assert.equal(receipt.evidence, evidence); assert.equal(receipt.live, live);
  assert.ok(!existsSync(path.join(evidence, 'ready.json')), 'This preparation already completed.');
  validateInfo(info(app), testFeed);
  assert.equal(treeDigest(app), receipt.lower.bundleTreeSHA256);
  assert.equal(treeDigest(source), receipt.original.bundleTreeSHA256);
  if (submitting) {
    signature(app);
    submit();
    process.exit(0);
  }
  const submission = JSON.parse(readFileSync(path.join(evidence, 'notary-submission.json'), 'utf8'));
  assert.match(submission.id || '', /^[0-9a-f-]{36}$/i);
  assert.equal(sha256(archive), submission.archiveSHA256);
  const status = JSON.parse(command('/usr/bin/xcrun', ['notarytool', 'info', submission.id,
    '--keychain-profile', 'nyneapps', '--output-format', 'json']).stdout);
  save(`notary-status-${Date.now()}.json`, status);
  assert.equal(status.status, 'Accepted', `Apple status is ${status.status}; no successful notarization or staple is claimed.`);
  command('/usr/bin/xcrun', ['notarytool', 'log', submission.id, '--keychain-profile', 'nyneapps', path.join(evidence, 'apple-notary-log.json')]);
  command('/usr/bin/xcrun', ['stapler', 'staple', app]);
  command('/usr/bin/xcrun', ['stapler', 'validate', app]);
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
  assert.equal(treeDigest(source), receipt.original.bundleTreeSHA256);
  const ready = { schema: 1, runID, preparedAt: new Date().toISOString(), app, evidence, testFeed,
    version: '0.1.2', build: '3', submissionID: submission.id, appleStatus: status.status,
    signature: signature(app), originalSourceUnchanged: true, launched: false, published: false,
    scope: 'Prepared real manager lower candidate only. Self-update/download/relaunch and state preservation are not yet tested.' };
  save('ready.json', ready);
  console.log(JSON.stringify(ready, null, 2));
}
