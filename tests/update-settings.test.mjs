import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateUpdateSettings, validateReleaseVersion, updatePlistValues } from '../scripts/lib/update-settings.mjs';

const config = {
  repository: 'example/app', feedURL: 'https://github.com/example/app/releases/latest/download/appcast.xml',
  publicKey: Buffer.alloc(32, 12).toString('base64'), keychainAccount: 'dev.example.app',
};

test('update feed is pinned to the selected HTTPS repository without credentials or query overrides', () => {
  assert.equal(validateUpdateSettings(config), config);
  for (const feedURL of ['http://github.com/example/app/releases/latest/download/appcast.xml',
    config.feedURL + '?token=secret', config.feedURL + '#other', config.feedURL.replace('example/app', 'other/app'),
    'https://github.com@example.net/feed.xml']) {
    assert.throws(() => validateUpdateSettings({ ...config, feedURL }));
  }
});
test('invalid public keys and signing account names fail before building', () => {
  for (const publicKey of ['', config.publicKey + '\n', Buffer.alloc(31).toString('base64'), 'not a key']) {
    assert.throws(() => validateUpdateSettings({ ...config, publicKey }));
  }
  assert.throws(() => validateUpdateSettings({ ...config, keychainAccount: '' }));
});
test('defaults require signatures before extraction and on feeds without profiling', () => {
  const values = updatePlistValues(config);
  assert.equal(values.SUEnableAutomaticChecks, true);
  assert.equal(values.SUAutomaticallyUpdate, false);
  assert.equal(values.SUVerifyUpdateBeforeExtraction, true);
  assert.equal(values.SURequireSignedFeed, true);
  assert.equal(values.SUSignedFeedFailureExpirationInterval, 0);
  assert.equal(values.SUEnableSystemProfiling, false);
  assert.equal(values.SUEnableJavaScript, false);
});
test('release versions and build numbers reject ambiguous or unsafe values', () => {
  validateReleaseVersion('1.2.3', '2');
  for (const version of ['', 'v1.0.0', '1.0', '1.0.0-beta']) assert.throws(() => validateReleaseVersion(version, '2'));
  for (const build of ['', '0', '-1', '1.2', '01', '9007199254740992']) assert.throws(() => validateReleaseVersion('1.0.0', build));
});
