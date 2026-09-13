import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { packageRuntime } from './lib/package-runtime.mjs';
import { macOSBuildArguments, verifyMacOSBuildVersions } from './lib/macos-build-settings.mjs';
import { applyPlistValues, embedSparkle, updatePlistValues, validateReleaseVersion } from './lib/update-settings.mjs';
import { prepareBundledNode } from './lib/bundled-node.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'macos');
const updateConfig = JSON.parse(readFileSync(path.join(packagePath, 'UpdateConfiguration.json'), 'utf8'));
const updaterValues = updatePlistValues(updateConfig);
const release = process.argv.includes('--release');
const signingIdentity = process.env.EA_SIGN_IDENTITY || '-';
if (release) {
  if (!signingIdentity.startsWith('Developer ID Application: ')) throw new Error('Release builds require EA_SIGN_IDENTITY with a Developer ID Application certificate.');
  validateReleaseVersion(process.env.EA_VERSION, process.env.EA_BUILD_NUMBER);
}
const query = args => execFileSync('/usr/bin/xcrun', args, { encoding: 'utf8', cwd: os.tmpdir() }).trim();
const settings = {
  packagePath,
  sdkPath: query(['--sdk', 'macosx', '--show-sdk-path']),
  sdkVersion: query(['--sdk', 'macosx', '--show-sdk-version']),
  sdkBuildVersion: query(['--sdk', 'macosx', '--show-sdk-build-version']),
  swiftPath: query(['--find', 'swift']),
  swiftVersion: query(['swift', '--version']),
};
const args = macOSBuildArguments(settings);
const scratchPath = args[args.indexOf('--scratch-path') + 1];
const sparkleArtifactRoot = path.join(scratchPath, 'artifacts', 'sparkle', 'Sparkle');
const buildOptions = { cwd: os.tmpdir(), env: { ...process.env, SDKROOT: settings.sdkPath } };
const bundledNode = await prepareBundledNode({ cacheRoot: path.join(packagePath, '.build', 'node-distributions') });

execFileSync(settings.swiftPath, args, { ...buildOptions, stdio: 'inherit' });
const binaryDirectory = execFileSync(settings.swiftPath, [...args, '--show-bin-path'], {
  ...buildOptions, encoding: 'utf8',
}).trim();
const executableMetadata = {};
// Validate all products before replacing anything in the packaged application.
for (const name of ['ExtensionsAnywhere', 'ExtensionLauncher', 'CatalogAppLaunch', 'ProcessIdentity']) {
  const output = query(['vtool', '-show-build', path.join(binaryDirectory, name)]);
  executableMetadata[name] = verifyMacOSBuildVersions(output, { sdkVersion: settings.sdkVersion });
}

const app = path.join(root, 'dist', 'Extensions Anywhere.app');
const contents = path.join(app, 'Contents');
mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
copyFileSync(path.join(binaryDirectory, 'ExtensionsAnywhere'), path.join(contents, 'MacOS', 'ExtensionsAnywhere'));
copyFileSync(path.join(packagePath, 'Info.plist'), path.join(contents, 'Info.plist'));
applyPlistValues(path.join(contents, 'Info.plist'), {
  ...updaterValues,
  ...(release ? { CFBundleShortVersionString: process.env.EA_VERSION, CFBundleVersion: process.env.EA_BUILD_NUMBER } : {}),
});
const resources = path.join(contents, 'Resources');
mkdirSync(resources, { recursive: true });
writeFileSync(path.join(resources, 'BuildEnvironment.json'), JSON.stringify({
  builtAt: new Date().toISOString(), backend: 'native', minimumVersion: '14.0', ...settings, executableMetadata,
  sparkleVersion: '2.9.6', sparkleArtifactRoot,
  node: { version: bundledNode.version, architecture: bundledNode.architecture, archiveSHA256: bundledNode.archiveSHA256, dependencies: bundledNode.dependencies },
}, null, 2) + '\n');
copyFileSync(path.join(binaryDirectory, 'ExtensionLauncher'), path.join(resources, 'ExtensionLauncher'));
copyFileSync(path.join(binaryDirectory, 'CatalogAppLaunch'), path.join(resources, 'CatalogAppLaunch'));
copyFileSync(path.join(binaryDirectory, 'ProcessIdentity'), path.join(resources, 'ProcessIdentity'));
copyFileSync(path.join(root, 'compatibility', 'runtime-profiles.json'), path.join(resources, 'runtime-profiles.json'));
const signingFlags = signingIdentity === '-' ? [] : ['--options', 'runtime', '--timestamp'];
// Sign before hashing/copying the native helper into the sealed runtime manifest.
for (const name of ['ExtensionLauncher', 'CatalogAppLaunch', 'ProcessIdentity']) {
  execFileSync('/usr/bin/codesign', ['--force', '--sign', signingIdentity, ...signingFlags, path.join(resources, name)], { stdio: 'inherit' });
}
const stagedNode = path.join(resources, '.node-build');
copyFileSync(bundledNode.executable, stagedNode);
execFileSync('/usr/bin/codesign', ['--force', '--sign', signingIdentity, ...signingFlags,
  '--entitlements', path.join(packagePath, 'Node.entitlements'), stagedNode], { stdio: 'inherit' });
packageRuntime({ root, resources, appLaunchHelper: path.join(resources, 'CatalogAppLaunch'),
  processIdentityHelper: path.join(resources, 'ProcessIdentity'), nodeExecutable: stagedNode, nodeLicense: bundledNode.license });
rmSync(stagedNode);
writeFileSync(path.join(resources, 'LaunchEnvironment.json'), JSON.stringify({
  schemaVersion: '2', nodeRelativePath: 'Runtime/native/node', nodeVersion: bundledNode.version,
}, null, 2));

embedSparkle({ artifactRoot: sparkleArtifactRoot, contents, identity: signingIdentity });
// Sign our manager only. Never target a discovered third-party app.
execFileSync('/usr/bin/codesign', ['--force', '--sign', signingIdentity, ...signingFlags, app], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
console.log(`Built ${app}`);
