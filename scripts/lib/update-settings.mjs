import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function validateUpdateSettings(config) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? '')) {
    throw new Error('Update repository must be owner/name.');
  }
  const expected = `https://github.com/${config.repository}/releases/latest/download/appcast.xml`;
  if (config.feedURL !== expected) throw new Error('Update feed must use the configured repository’s HTTPS release feed.');
  const key = Buffer.from(config.publicKey ?? '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== config.publicKey) {
    throw new Error('A canonical 32-byte Ed25519 public key is required.');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(config.keychainAccount ?? '')) throw new Error('A Keychain signing account is required.');
  return config;
}

export function updatePlistValues(config) {
  validateUpdateSettings(config);
  return {
    SUFeedURL: config.feedURL,
    SUPublicEDKey: config.publicKey,
    SUEnableAutomaticChecks: true,
    SUAutomaticallyUpdate: false,
    SUScheduledCheckInterval: 86400,
    SUVerifyUpdateBeforeExtraction: true,
    SURequireSignedFeed: true,
    SUSignedFeedFailureExpirationInterval: 0,
    SUEnableSystemProfiling: false,
    SUEnableJavaScript: false,
  };
}

export function validateReleaseVersion(version, buildNumber) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('EA_VERSION must be a numeric major.minor.patch version.');
  if (!/^[1-9]\d*$/.test(buildNumber ?? '') || !Number.isSafeInteger(Number(buildNumber))) {
    throw new Error('EA_BUILD_NUMBER must be a positive integer, increasing with every published release.');
  }
}

export function applyPlistValues(plist, values) {
  for (const [key, value] of Object.entries(values)) {
    const type = typeof value === 'boolean' ? '-bool' : typeof value === 'number' ? '-integer' : '-string';
    execFileSync('/usr/bin/plutil', ['-replace', key, type, String(value), plist]);
  }
}

export function embedSparkle({ artifactRoot, contents, identity = '-' }) {
  const source = path.join(artifactRoot, 'Sparkle.xcframework', 'macos-arm64_x86_64', 'Sparkle.framework');
  if (!existsSync(source)) throw new Error(`Sparkle framework missing: ${source}`);
  const framework = path.join(contents, 'Frameworks', 'Sparkle.framework');
  // ditto preserves framework version symlinks and executable permissions.
  execFileSync('/usr/bin/ditto', [source, framework]);
  const version = path.join(framework, 'Versions', 'B');
  const nested = [
    ['XPCServices/Installer.xpc', false], ['XPCServices/Downloader.xpc', true],
    ['Autoupdate', false], ['Updater.app', false], ['', false],
  ];
  for (const [relative, preserveEntitlements] of nested) {
    const target = relative ? path.join(version, relative) : framework;
    const flags = identity === '-' ? [] : ['--options', 'runtime', '--timestamp'];
    if (preserveEntitlements) flags.push('--preserve-metadata=entitlements');
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, ...flags, target], { stdio: 'inherit' });
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', framework], { stdio: 'inherit' });
  execFileSync('/usr/bin/ditto', [path.join(artifactRoot, 'LICENSE'), path.join(contents, 'Resources', 'Sparkle-LICENSE')]);
}
