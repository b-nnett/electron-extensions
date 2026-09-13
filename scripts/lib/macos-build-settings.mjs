import { createHash } from 'node:crypto';
import path from 'node:path';

const versionParts = value => {
  if (typeof value !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid macOS version: ${value}`);
  return value.split('.').map(Number).concat([0]).slice(0, 3);
};
const sameVersion = (left, right) => versionParts(left).every((value, index) => value === versionParts(right)[index]);

export function macOSBuildArguments({ packagePath, sdkPath, sdkVersion, sdkBuildVersion, swiftPath, swiftVersion }) {
  if (![packagePath, sdkPath, swiftPath].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Build paths must be absolute.');
  if (versionParts(sdkVersion)[0] < 26) throw new Error('Building the current macOS appearance requires SDK 26 or later. Select a current Xcode SDK.');
  if (![sdkBuildVersion, swiftVersion].every(value => typeof value === 'string' && value.trim())) throw new Error('Build toolchain identity is missing.');
  const identity = createHash('sha256').update(JSON.stringify({ sdkPath, sdkVersion, sdkBuildVersion, swiftPath, swiftVersion, backend: 'native' })).digest('hex').slice(0, 20);
  // Swift 6.4's default Swift Build backend reproduced sdk=minos in a fresh
  // package even with --sdk. The documented native backend preserves SDK 27.
  return ['build', '--package-path', packagePath, '--configuration', 'release', '--build-system', 'native',
    '--sdk', sdkPath, '--scratch-path', path.join(packagePath, '.build', `native-sdk-${identity}`)];
}

export function verifyMacOSBuildVersions(output, { sdkVersion, minimumVersion = '14.0' }) {
  versionParts(sdkVersion); versionParts(minimumVersion);
  const records = [...output.matchAll(/\bcmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform (\S+)\s+minos (\S+)\s+sdk (\S+)/g)]
    .map(match => ({ platform: match[1], minimumVersion: match[2], sdkVersion: match[3] }));
  if (!records.length || /\bcmd LC_VERSION_MIN_/.test(output)) throw new Error('Built executable lacks unambiguous modern SDK load commands.');
  for (const record of records) {
    if (record.platform !== 'MACOS' || !sameVersion(record.minimumVersion, minimumVersion) || !sameVersion(record.sdkVersion, sdkVersion)) {
      throw new Error(`Built executable SDK metadata mismatch: ${JSON.stringify(record)}; expected macOS minimum ${minimumVersion}, SDK ${sdkVersion}.`);
    }
  }
  return records;
}
