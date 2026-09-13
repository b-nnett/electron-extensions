import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUpdateSettings } from '../lib/update-settings.mjs';

// Test assets for the actual manager's reviewed build-3 -> build-11 update.
// No app launch, notarization submission, bundle edit/re-sign, preference change,
// private-key export, GitHub upload, or production-feed mutation occurs here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceBase = path.join(root, 'output/release-review/2026-09-13');
const expectedApp = path.join(evidenceBase, 'notarization/build-11/Extensions Anywhere.app');
const lowerReceiptPath = path.join(evidenceBase, 'manager-self-update-cb137ea0-1972-40ca-ba46-3176731d67c3/preparation.json');
const releaseTag = 'updater-e2e-20260913';
const version = '0.1.10', build = '11';
const repository = 'b-nnett/electron-extensions';
const downloadPrefix = `https://github.com/${repository}/releases/download/${releaseTag}/`;
const testFeed = `${downloadPrefix}appcast.xml`;
const usage = 'node scripts/testing/prepare-manager-update-assets.mjs --accepted-app "' + expectedApp + '"';
if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(usage + '\nRun only after the root task supplies this exact accepted, frozen candidate. Nothing is uploaded.');
  process.exit(0);
}
assert.equal(process.argv.length, 4, usage);
assert.equal(process.argv[2], '--accepted-app', usage);
assert.equal(process.argv[3], expectedApp, 'Only the reviewed frozen build-11 path is accepted.');
const app = process.argv[3];
assert.equal(realpathSync(app), app, 'The candidate cannot be an alias.');
assert.equal(realpathSync(evidenceBase), evidenceBase);
assert.ok(lstatSync(app).isDirectory());
const config = validateUpdateSettings(JSON.parse(readFileSync(path.join(root, 'macos/UpdateConfiguration.json'), 'utf8')));
assert.equal(config.repository, repository);
assert.equal(config.keychainAccount, 'dev.extensions-anywhere.app');
const lower = JSON.parse(readFileSync(lowerReceiptPath, 'utf8'));
assert.equal(lower.testFeed, testFeed);
assert.equal(lower.sourceInfo.CFBundleVersion, '3');
assert.equal(lower.sourceInfo.SUPublicEDKey, config.publicKey);
assert.ok(Number(build) > Number(lower.sourceInfo.CFBundleVersion));

const runID = randomUUID();
const output = path.join(evidenceBase, `manager-update-build11-${runID}`);
mkdirSync(output, { mode: 0o700 });
const assets = path.join(output, 'Assets');
mkdirSync(assets, { mode: 0o700 });
let commandNumber = 0;
function command(executable, args, timeout = 60000) {
  const number = ++commandNumber;
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(path.join(output, `command-${number}.log`), (result.stdout || '') + (result.stderr || ''), { mode: 0o600, flag: 'wx' });
  assert.equal(result.status, 0, `Command ${number} failed; inspect its preserved log. ${result.error?.message ?? ''}`);
  return { stdout: (result.stdout || '').trim(), stderr: result.stderr || '' };
}
function save(filename, value) {
  writeFileSync(path.join(output, filename), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function treeDigest(directory) {
  const entries = [];
  function visit(relative) {
    const file = path.join(directory, relative), stat = lstatSync(file);
    if (stat.isSymbolicLink()) entries.push([relative, 'symlink', readlinkSync(file)]);
    else if (stat.isDirectory()) for (const child of readdirSync(file).sort()) visit(path.join(relative, child));
    else { assert.ok(stat.isFile()); entries.push([relative, 'file', stat.mode & 0o777, sha256(file)]); }
  }
  visit('');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
function info(bundle) {
  return JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')]).stdout);
}
function validateInfo(value) {
  assert.equal(value.CFBundleIdentifier, 'dev.extensions-anywhere.app');
  assert.equal(value.CFBundleExecutable, 'ExtensionsAnywhere');
  assert.equal(value.CFBundleShortVersionString, version);
  assert.equal(value.CFBundleVersion, build);
  assert.equal(value.SUFeedURL, config.feedURL, 'The higher app retains its production feed.');
  assert.equal(value.SUPublicEDKey, config.publicKey);
  assert.equal(value.SURequireSignedFeed, true);
  assert.equal(value.SUVerifyUpdateBeforeExtraction, true);
}
function signature(bundle) {
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const detail = command('/usr/bin/codesign', ['--display', '--verbose=4', bundle]).stderr;
  assert.match(detail, /^TeamIdentifier=X522N436T7$/m);
  assert.match(detail, /^Authority=Developer ID Application: Nyne Apps LTD\. \(X522N436T7\)$/m);
  assert.match(detail, /flags=0x10000\(runtime\)/);
  const cdhash = detail.match(/^CDHash=([a-f0-9]+)$/m)?.[1];
  assert.ok(cdhash);
  return { cdhash, team: 'X522N436T7', developerID: true, hardenedRuntime: true,
    executableSHA256: sha256(path.join(bundle, 'Contents/MacOS/ExtensionsAnywhere')), bundleTreeSHA256: treeDigest(bundle) };
}

console.log(`Preparing reviewed test assets in ${output}`);
const sourceInfo = info(app); validateInfo(sourceInfo);
const original = signature(app);
command('/usr/bin/xcrun', ['stapler', 'validate', app]);
command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
const environment = JSON.parse(readFileSync(path.join(app, 'Contents/Resources/BuildEnvironment.json'), 'utf8'));
assert.equal(environment.sparkleVersion, '2.9.6');
const artifactRoot = environment.sparkleArtifactRoot;
assert.equal(typeof artifactRoot, 'string');
assert.ok(artifactRoot.startsWith(path.join(root, 'macos/.build') + '/') && artifactRoot.endsWith('/artifacts/sparkle/Sparkle'));
const tools = path.join(artifactRoot, 'bin');
assert.equal(realpathSync(tools), tools);
const toolHashes = Object.fromEntries(['generate_keys', 'generate_appcast', 'sign_update'].map(name => {
  const file = path.join(tools, name); assert.ok(lstatSync(file).isFile()); return [name, sha256(file)];
}));
assert.equal(command(path.join(tools, 'generate_keys'), ['--account', config.keychainAccount, '-p']).stdout, config.publicKey,
  'Use the existing matching update key; never create or export another key.');
const filename = `Extensions-Anywhere-${version}-${build}.zip`;
const archive = path.join(assets, filename), appcast = path.join(assets, 'appcast.xml');
command('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
command(path.join(tools, 'generate_appcast'), ['--account', config.keychainAccount,
  '--download-url-prefix', downloadPrefix, '--maximum-deltas', '0', '--maximum-versions', '1', assets]);
assert.deepEqual(readdirSync(assets).sort(), [filename, 'appcast.xml'].sort(), 'Only the reviewed full archive and feed may be published.');
command(path.join(tools, 'sign_update'), ['--account', config.keychainAccount, '--verify', appcast]);
assert.ok(lstatSync(appcast).size <= 1024 * 1024);
const xpath = expression => command('/usr/bin/xmllint', ['--nonet', '--xpath', expression, appcast]).stdout;
assert.equal(xpath('count(/rss/channel/item)'), '1');
assert.equal(xpath('count(/rss/channel/item/enclosure)'), '1');
assert.equal(xpath('count(/rss/channel/item/*[local-name()="channel"])'), '0', 'Do not add a Sparkle channel the lower manager has not opted into.');
assert.equal(xpath('string(/rss/channel/item/*[local-name()="version"])'), build);
assert.equal(xpath('string(/rss/channel/item/*[local-name()="shortVersionString"])'), version);
assert.equal(xpath('string(/rss/channel/item/enclosure/@url)'), downloadPrefix + filename);
assert.equal(Number(xpath('string(/rss/channel/item/enclosure/@length)')), lstatSync(archive).size);
const archiveSignature = xpath('string(/rss/channel/item/enclosure/@*[local-name()="edSignature"])');
command(path.join(tools, 'sign_update'), ['--account', config.keychainAccount, '--verify', archive, archiveSignature]);
const publicKey = createPublicKey({ format: 'der', type: 'spki',
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(config.publicKey, 'base64')]) });
assert.ok(verify(null, readFileSync(archive), publicKey, Buffer.from(archiveSignature, 'base64')));

const expanded = path.join(output, 'Expanded'); mkdirSync(expanded, { mode: 0o700 });
command('/usr/bin/ditto', ['-x', '-k', archive, expanded]);
const extracted = path.join(expanded, 'Extensions Anywhere.app');
assert.deepEqual(info(extracted), sourceInfo);
const extractedSignature = signature(extracted);
assert.deepEqual(extractedSignature, original, 'The delivered app must match the frozen candidate.');
command('/usr/bin/xcrun', ['stapler', 'validate', extracted]);
command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', extracted]);
assert.equal(treeDigest(app), original.bundleTreeSHA256, 'Preparation must not modify the frozen candidate.');
const publicationPlan = { repository, tag: releaseTag, prerelease: true, makeLatest: false,
  feedURL: testFeed, assets: [archive, appcast].map(file => ({ file, filename: path.basename(file),
    bytes: lstatSync(file).size, sha256: sha256(file) })) };
save('verification.json', { schema: 1, runID, createdAt: new Date().toISOString(), app, output, version, build,
  lowerReceiptPath, lowerBuild: lower.sourceInfo.CFBundleVersion, productionFeedRetained: sourceInfo.SUFeedURL,
  original, extractedSignature, sourceUnchanged: true, archiveSignatureVerified: true, feedSignatureVerified: true,
  stapleValidated: true, gatekeeperAccepted: true, sparkleVersion: environment.sparkleVersion, tools, toolHashes,
  publicationPlan, published: false, managerLaunched: false, selfUpdateVerified: false });
writeFileSync(path.join(output, 'release-notes.md'), 'Updater validation prerelease for Extensions Anywhere.\n\nThis separate public test feed supplies the reviewed 0.1.10 (11) candidate to the prepared 0.1.2 (3) test manager. It is not the production Latest release. App-specific extension coverage remains scoped to the recorded test evidence.\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ output, publicationPlan, published: false, next: 'Root reviews the exact hashes and authorizes test-prerelease publication separately.' }, null, 2));
