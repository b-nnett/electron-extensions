import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { validateReleaseVersion, validateUpdateSettings } from './lib/update-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return process.argv[index + 1];
};
const developmentTest = process.argv.includes('--development-test');
const app = path.resolve(option('--app') || path.join(root, 'dist', 'Extensions Anywhere.app'));
const config = validateUpdateSettings(JSON.parse(readFileSync(path.join(root, 'macos', 'UpdateConfiguration.json'), 'utf8')));
const outputArg = option('--output');
if (!outputArg) throw new Error('Pass --output with an empty directory for reviewable update artifacts. Nothing is uploaded.');
const output = path.resolve(outputArg);
if (existsSync(output) && readdirSync(output).length) throw new Error('Output must be empty; previous release artifacts are never overwritten.');
const run = (executable, args) => execFileSync(executable, args, { encoding: 'utf8' }).trim();
const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')]));
validateReleaseVersion(plist.CFBundleShortVersionString, plist.CFBundleVersion);
if (plist.CFBundleIdentifier !== 'dev.extensions-anywhere.app'
    || plist.SUFeedURL !== config.feedURL || plist.SUPublicEDKey !== config.publicKey
    || !plist.SURequireSignedFeed || !plist.SUVerifyUpdateBeforeExtraction) {
  throw new Error('The built manager does not match the configured updater identity and signing requirements.');
}
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
if (!developmentTest) {
  // Gatekeeper acceptance is required for a release artifact; this does not notarize or publish anything.
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
}
const metadata = JSON.parse(readFileSync(path.join(app, 'Contents', 'Resources', 'BuildEnvironment.json'), 'utf8'));
const toolsOverride = option('--tools');
if (!toolsOverride && (!metadata.sparkleArtifactRoot || !path.isAbsolute(metadata.sparkleArtifactRoot))) {
  throw new Error('Rebuild the manager to record its Sparkle tools location, or pass --tools.');
}
const tools = path.resolve(toolsOverride || path.join(metadata.sparkleArtifactRoot, 'bin'));
const key = run(path.join(tools, 'generate_keys'), ['--account', config.keychainAccount, '-p']);
if (key !== config.publicKey) throw new Error('The Keychain signing key does not match the public key in the app.');
mkdirSync(output, { recursive: true });
const version = plist.CFBundleShortVersionString;
const filename = `Extensions-Anywhere-${version}-${plist.CFBundleVersion}.zip`;
const archive = path.join(output, filename);
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
const prefix = `https://github.com/${config.repository}/releases/download/v${version}/`;
run(path.join(tools, 'generate_appcast'), [
  '--account', config.keychainAccount, '--download-url-prefix', prefix,
  '--maximum-deltas', '0', '--maximum-versions', '1', output,
]);
const appcast = path.join(output, 'appcast.xml');
run(path.join(tools, 'sign_update'), ['--account', config.keychainAccount, '--verify', appcast]);
const xml = readFileSync(appcast, 'utf8');
const signature = xml.match(/sparkle:edSignature="([A-Za-z0-9+/=]+)"/)?.[1];
const publicKey = createPublicKey({
  format: 'der', type: 'spki',
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(config.publicKey, 'base64')]),
});
const archiveData = readFileSync(archive);
if (!signature || !verify(null, archiveData, publicKey, Buffer.from(signature, 'base64'))) {
  throw new Error('Generated archive signature does not validate with the public key shipped in the app.');
}
writeFileSync(path.join(output, 'verification.json'), JSON.stringify({
  developmentTest, publishable: !developmentTest, repository: config.repository,
  feedURL: config.feedURL, downloadPrefix: prefix, version, build: plist.CFBundleVersion,
  sha256: createHash('sha256').update(archiveData).digest('hex'),
  archiveSignatureVerified: true, feedSignatureVerified: true,
  createdAt: new Date().toISOString(),
}, null, 2) + '\n');
console.log(`Prepared ${output}. ${developmentTest ? 'DEVELOPMENT TEST ONLY — do not publish.' : 'Not published. Review version ordering and complete the update round trip before publishing.'}`);
