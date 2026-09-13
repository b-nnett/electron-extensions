import test from 'node:test';
import assert from 'node:assert/strict';
import { macOSBuildArguments, verifyMacOSBuildVersions } from '../scripts/lib/macos-build-settings.mjs';

const settings = {
  packagePath: '/Synthetic/App/macos', sdkPath: '/Synthetic/Xcode/SDKs/MacOSX27.0.sdk',
  sdkVersion: '27.0', sdkBuildVersion: '27A123', swiftPath: '/Synthetic/Xcode/usr/bin/swift', swiftVersion: 'Apple Swift version 6.4',
};
const buildVersion = (sdk = '27.0', minimum = '14.0', platform = 'MACOS') => `
Load command 11
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform ${platform}
    minos ${minimum}
      sdk ${sdk}
   ntools 1
     tool LD
  version 1328.2
`;
const option = (args, name) => args[args.indexOf(name) + 1];

test('release build explicitly uses selected SDK and native backend without platform overrides', () => {
  const args = macOSBuildArguments(settings);
  assert.equal(option(args, '--configuration'), 'release');
  assert.equal(option(args, '--build-system'), 'native');
  assert.equal(option(args, '--sdk'), settings.sdkPath);
  assert.match(option(args, '--scratch-path'), /^\/Synthetic\/App\/macos\/\.build\/native-sdk-[a-f0-9]{20}$/);
  assert.equal(args.includes('-Xlinker'), false);
  assert.deepEqual(macOSBuildArguments(settings), args);
});

test('scratch identity changes with SDK build, SDK location and Swift toolchain', () => {
  const original = option(macOSBuildArguments(settings), '--scratch-path');
  for (const change of [
    { sdkVersion: '27.1' }, { sdkBuildVersion: '27A124' }, { sdkPath: '/Synthetic/NewSDK/MacOSX27.0.sdk' },
    { swiftPath: '/Synthetic/OtherXcode/usr/bin/swift' }, { swiftVersion: 'Apple Swift version 6.4.1' },
  ]) assert.notEqual(option(macOSBuildArguments({ ...settings, ...change }), '--scratch-path'), original);
});

test('missing tool identity, relative paths and pre-Liquid-Glass SDKs fail before build', () => {
  for (const change of [{ sdkVersion: '14.0' }, { sdkVersion: 'unknown' }, { swiftVersion: '' }, { sdkBuildVersion: '' }, { sdkPath: 'relative.sdk' }, { swiftPath: 'swift' }]) {
    assert.throws(() => macOSBuildArguments({ ...settings, ...change }));
  }
});

test('modern metadata preserves minimum macOS14 separately from SDK27', () => {
  assert.deepEqual(verifyMacOSBuildVersions(buildVersion(), { sdkVersion: '27.0' }), [
    { platform: 'MACOS', minimumVersion: '14.0', sdkVersion: '27.0' },
  ]);
  assert.equal(verifyMacOSBuildVersions(buildVersion('27.0.0', '14.0.0'), { sdkVersion: '27.0' }).length, 1);
});

test('old SDK regression, raised deployment target and wrong platform fail metadata validation', () => {
  for (const output of [buildVersion('14.0'), buildVersion('26.2'), buildVersion('27.0', '27.0'), buildVersion('27.0', '14.0', 'IOS'), '', 'cmd LC_VERSION_MIN_MACOSX\nversion 14.0\nsdk 27.0']) {
    assert.throws(() => verifyMacOSBuildVersions(output, { sdkVersion: '27.0' }));
  }
});

test('every architecture slice must report the expected SDK', () => {
  const two = `binary (architecture arm64):\n${buildVersion()}binary (architecture x86_64):\n${buildVersion()}`;
  assert.equal(verifyMacOSBuildVersions(two, { sdkVersion: '27.0' }).length, 2);
  assert.throws(() => verifyMacOSBuildVersions(buildVersion() + buildVersion('14.0'), { sdkVersion: '27.0' }), /mismatch/);
});
