import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURE_APP_KEY, MAX_COMBINED_CSS_BYTES, MAX_FIXTURE_JS_BYTES,
  selectFixtureCSS, selectFixtureExtensions, selectChatGPTCSS, readFixtureExtensionLibrary } from '../lib/dock-library.mjs';
import { applyFixtureSources, restoreFixtureSources, FixtureExtensionLogFile, fixtureJSStateProof,
  fixtureReapplicationUpdate, recordFixtureCleanupResult } from '../scripts/dock-fixture-session.mjs';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const record = (files = [{ fileName: 'theme.css', type: 'css', text: 'button { color: green; }' }], overrides = {}) => ({
  id, appKey: FIXTURE_APP_KEY, name: 'Test extension', isEnabled: true,
  sourceType: files[0].type, sourceFileName: files[0].fileName.split('/').at(-1), sourceText: files[0].text,
  sourceFiles: files, ...overrides
});
const select = (...records) => selectFixtureExtensions({ records, logs: [] });
const script = (text = "console.log('extension only');", fileName = 'behavior.js') => ({ fileName, type: 'js', text });
const state = (phase = 'active') => ({ extensionID: id, revision: 'hash1', phase, generation: 1,
  cleanupComplete: phase === 'disabled', reloadBlocked: false, fileNames: ['behavior.js'], lastError: null });

test('fixture mixed selection preserves CSS order and hashes ordered script bytes without changing vendor guards', () => {
  const first = record([{ fileName: 'nested/theme.css', type: 'css', text: 'a {}' }, script('/* café */', 'nested/one.js'), script('two()', 'two.js')]);
  const result = select(first, record([{ fileName: 'last.css', type: 'css', text: 'b {}' }], { id: randomUUID() }));
  assert.equal(result.css, 'a {}\nb {}');
  assert.equal(result.cssBytes, Buffer.byteLength(result.css));
  assert.equal(result.jsBytes, Buffer.byteLength('/* café */two()'));
  assert.equal(result.hasContent, true);
  assert.deepEqual(result.jsExtensions[0].files, [{ fileName: 'nested/one.js', text: '/* café */' }, { fileName: 'two.js', text: 'two()' }]);
  assert.match(result.jsExtensions[0].revision, /^[a-f0-9]{64}$/);
  assert.notEqual(select(record([script('different()')])).jsExtensions[0].revision, select(record([script()])).jsExtensions[0].revision);
  assert.equal(selectFixtureExtensions({ records: [first], logs: ['unrelated'] }).revisionKey, select(first).revisionKey);
  assert.throws(() => selectFixtureCSS({ records: [first] }), /not supported/);
  assert.throws(() => selectChatGPTCSS({ records: [{ ...first, appKey: 'com.openai.codex' }] }), /not supported/);
});

test('fixture JS-only selection works and leaves disabled/other-app scripts inert', () => {
  const result = select(record([script()]), record([script('ignored')], { appKey: 'other', id: 'old-other-id' }),
    record([script('ignored')], { isEnabled: false, id: 'old-disabled-id' }));
  assert.equal(result.hasCSS, false); assert.equal(result.hasContent, true);
  assert.equal(result.jsExtensions.length, 1);
  assert.equal(select().hasContent, false);
  assert.throws(() => select(record([script(' \n\t')])), /empty or whitespace/);
  assert.equal(select(record([script('')]), record([script()], { id: randomUUID() })).hasContent, true);
});

test('fixture selection rejects ambiguous IDs, filenames, legacy metadata and record/file excess', () => {
  for (const changes of [{ id: 'legacy' }, { sourceText: 'different' }, { sourceType: 'css' }, { sourceFileName: 'different.js' }]) {
    assert.throws(() => select(record([script()], changes)));
  }
  assert.throws(() => select(record([script()]), record([script()], { id: id.toUpperCase() })), /unique UUID/);
  for (const fileName of ['../a.js', '/a.js', 'a//b.js', 'a\\b.js', 'a:b.js', 'a\n.js', 'a\u0085.js', 'é'.repeat(128) + '.js']) {
    assert.throws(() => select(record([script('x', fileName)])), /contained/);
  }
  assert.throws(() => select(record([script(), script()])), /unique/);
  assert.throws(() => select(record(Array.from({ length: 33 }, (_, i) => script('x', `${i}.js`)))), /32 files/);
  assert.throws(() => select(...Array.from({ length: 65 }, () => record([script()], { id: randomUUID() }))), /64 enabled/);
});

test('fixture byte limits include CSS joins and UTF-8, with separate JS execution bytes', () => {
  assert.equal(select(record([script('x'.repeat(MAX_FIXTURE_JS_BYTES))])).jsBytes, MAX_FIXTURE_JS_BYTES);
  assert.throws(() => select(record([script('é'.repeat(MAX_FIXTURE_JS_BYTES / 2 + 1))])), /256 KiB/);
  const fullCSS = { fileName: 'full.css', type: 'css', text: 'x'.repeat(MAX_COMBINED_CSS_BYTES) };
  assert.equal(select(record([fullCSS, script()])).cssBytes, MAX_COMBINED_CSS_BYTES);
  assert.throws(() => select(record([fullCSS, { fileName: 'empty.css', type: 'css', text: '' }])), /64 KiB/);
  assert.equal(select(record([script('x'.repeat(MAX_FIXTURE_JS_BYTES - 1)), script('x', 'next.js')])).jsBytes, MAX_FIXTURE_JS_BYTES);
});

test('fixture apply waits for CSS then JS, and cleanup removes CSS even after JS failure', async () => {
  const events = [];
  const session = { styles: {
    apply: async css => { events.push(['css', css]); return { color: 'green' }; },
    remove: async () => { events.push(['remove-css']); return { color: 'original' }; }
  }, extensions: { sync: async definitions => { events.push(['js', definitions]); return [state(definitions.length ? 'active' : 'disabled')]; } } };
  const selection = select(record([{ fileName: 'theme.css', type: 'css', text: 'a {}' }, script()]));
  const applied = await applyFixtureSources(session, selection);
  assert.deepEqual(events.map(event => event[0]), ['css', 'js']);
  assert.equal(applied.jsStates[0].phase, 'active');
  events.length = 0;
  await restoreFixtureSources(session);
  assert.deepEqual(events.map(event => event[0]), ['js', 'remove-css']);
  session.extensions.sync = async () => { events.push(['js-failed']); throw new Error('private source detail'); };
  events.length = 0;
  await assert.rejects(restoreFixtureSources(session), /cleanup failed/);
  assert.deepEqual(events.map(event => event[0]), ['js-failed', 'remove-css']);
  assert.doesNotMatch(JSON.stringify(fixtureJSStateProof([{ ...state('failed'), lastError: { fileName: 'behavior.js', stage: 'load', message: 'private source detail' }, source: 'private source' }])), /private/);
});

test('fixture log file persists private bounded attributed events with sequence across document resets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fixture-log-test-'));
  try {
    const file = path.join(directory, 'extension-logs.json'), sessionID = randomUUID();
    const logs = new FixtureExtensionLogFile(file, sessionID);
    await logs.flush();
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).events, []);
    const event = { sequence: 1, extensionID: id, fileName: 'behavior.js', revision: 'hash1',
      level: 'log', message: 'fixture event', timestamp: new Date().toISOString(), sourceText: 'never persist source' };
    for (let i = 0; i < 700; i++) logs.append({ ...event, message: `${i} ${'é'.repeat(1800)}` });
    await logs.flush();
    const bytes = await readFile(file), saved = JSON.parse(bytes);
    assert.equal(saved.schema, 1); assert.equal(saved.sessionID, sessionID); assert.equal(saved.appKey, FIXTURE_APP_KEY);
    assert.ok(bytes.length <= 512 * 1024); assert.ok(saved.events.length <= 500);
    assert.equal(saved.events.at(-1).sequence, 700);
    assert.equal(saved.droppedEvents, 700 - saved.events.length);
    assert.ok(saved.events.every((event, index) => index === 0 || event.sequence > saved.events[index - 1].sequence));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.doesNotMatch(bytes.toString(), /never persist source/);
    assert.deepEqual(await readdir(directory), ['extension-logs.json']);
    assert.throws(() => logs.append({ ...event, extensionID: 'not-an-extension' }), /Invalid attributed/);
    assert.throws(() => logs.append({ ...event, message: 'x'.repeat(4097) }), /Invalid attributed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fixture log persistence failures remain visible to the broker', async () => {
  const logs = new FixtureExtensionLogFile('/unused-owned-test.json', randomUUID(), { writer: async () => { throw new Error('synthetic write refusal'); } });
  await assert.rejects(logs.flush(), /synthetic write refusal/);
  await assert.rejects(logs.flush(), /synthetic write refusal/);
});

test('reapplication state advances proof without accepting stale or failed selections', () => {
  const current = [state()], reapplied = [{ ...state(), generation: 3 }];
  const update = fixtureReapplicationUpdate(reapplied, current, 2, '2026-09-13T19:00:00.000Z');
  assert.equal(update.jsStates[0].generation, 3);
  assert.equal(update.jsReapplications, 2);
  assert.equal(update.jsReappliedAt, '2026-09-13T19:00:00.000Z');
  assert.equal(fixtureReapplicationUpdate([{ ...state(), revision: 'old' }], current, 3), null);
  assert.equal(fixtureReapplicationUpdate(reapplied, [], 3), null);
  assert.throws(() => fixtureReapplicationUpdate([state('failed')], current, 3), /did not become active/);
});

test('stop-time extension cleanup failure overrides earlier successful cleanup proof', () => {
  const report = { cleanup: { jsCleanupVerified: true }, errors: [] };
  recordFixtureCleanupResult({ extensionCleanupError: 'private script detail' }, report);
  assert.equal(report.cleanup.jsCleanupVerified, false);
  assert.equal(report.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /private script detail/);
  recordFixtureCleanupResult({ extensionCleanupError: 'same failure' }, report);
  assert.equal(report.errors.length, 1);
  const successful = { cleanup: { jsCleanupVerified: true }, errors: [] };
  recordFixtureCleanupResult({}, successful);
  assert.deepEqual(successful, { cleanup: { jsCleanupVerified: true }, errors: [] });
});

test('new fixture reader selects stored JS without reading source filename paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fixture-read-test-'));
  try {
    const file = path.join(directory, 'library.json'), input = { records: [record([script('one()', 'missing/behavior.js')])] };
    await writeFile(file, JSON.stringify(input));
    assert.deepEqual(await readFixtureExtensionLibrary(file), selectFixtureExtensions(input));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
