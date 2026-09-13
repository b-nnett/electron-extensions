import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXTURE_APP_KEY, CHATGPT_APP_KEY, MAX_COMBINED_CSS_BYTES,
  selectFixtureCSS, selectChatGPTCSS, readDockLibrary, readChatGPTDockLibrary
} from '../lib/dock-library.mjs';

const record = (overrides = {}) => ({
  id: 'first', appKey: FIXTURE_APP_KEY, name: 'Green button', isEnabled: true,
  sourceFileName: 'green.css', sourceType: 'css', sourceText: '#signal-button { color: green; }',
  ...overrides
});
const library = (...records) => ({ records, logs: [] });
const packaged = files => record({
  sourceFileName: files[0].fileName, sourceType: files[0].type,
  sourceText: files[0].text, sourceFiles: files
});

test('selects only enabled fixture CSS, leaving disabled and other-app JavaScript inert', () => {
  const result = selectFixtureCSS(JSON.stringify(library(
    record({ id: 'other-app', appKey: 'example.other', sourceType: 'js', sourceText: 'not executed' }),
    record({ id: 'disabled', isEnabled: false, sourceType: 'js', sourceText: 'not executed' }),
    record()
  )));
  assert.equal(result.css, record().sourceText);
  assert.deepEqual(result.enabledExtensionIDs, ['first']);
  assert.equal(result.hasCSS, true);
});

test('preserves record and package file cascade order with UTF-8 byte accounting', () => {
  const first = packaged([
    { fileName: 'base.css', type: 'css', text: '/* café */\na { color: red; }' },
    { fileName: 'override.css', type: 'css', text: 'a { color: blue; }' }
  ]);
  const second = record({ id: 'second', sourceText: 'a { color: green; }' });
  const result = selectFixtureCSS(library(first, second));
  assert.equal(result.css, first.sourceFiles.map(source => source.text).concat(second.sourceText).join('\n'));
  assert.deepEqual(result.sources.map(source => source.fileName), ['base.css', 'override.css', 'green.css']);
  assert.deepEqual(result.enabledExtensionIDs, ['first', 'second']);
  assert.equal(result.cssBytes, Buffer.byteLength(result.css, 'utf8'));
});

test('explicitly rejects both JavaScript records and mixed CSS/JavaScript packages', () => {
  assert.throws(() => selectFixtureCSS(library(record({ sourceType: 'js' }))), /JavaScript extensions are not supported/);
  const mixed = packaged([
    { fileName: 'theme.css', type: 'css', text: 'a {}' },
    { fileName: 'behavior.js', type: 'js', text: 'console.log("never executed")' }
  ]);
  assert.throws(() => selectFixtureCSS(library(mixed)), /mixed CSS\/JS extension/);
  assert.equal(selectFixtureCSS(library({ ...mixed, isEnabled: false })).hasCSS, false);
});

test('rejects malformed library and enabled record structures', () => {
  for (const input of ['{', null, [], {}, { records: {} }, library(null), library(record({ isEnabled: 'yes' }))]) {
    assert.throws(() => selectFixtureCSS(input), /Invalid extension library/);
  }
  for (const input of [
    record({ id: '' }), record({ name: '' }), record({ sourceType: 'unknown' }),
    record({ sourceText: null }), record({ sourceFileName: 'theme.js' }),
    record({ sourceFiles: [] }), record({ sourceFiles: {} })
  ]) assert.throws(() => selectFixtureCSS(library(input)), /Invalid extension library/);
  assert.throws(() => selectFixtureCSS(library(record(), record())), /unique IDs/);
});

test('rejects ambiguous package sources and inconsistent legacy first-source fields', () => {
  const files = [{ fileName: 'theme.css', type: 'css', text: 'a {}' }];
  assert.throws(() => selectFixtureCSS(library(packaged([...files, ...files]))), /filenames must be unique/);
  assert.throws(() => selectFixtureCSS(library({ ...packaged(files), sourceText: 'different {}' })), /first-source fields disagree/);
  assert.throws(() => selectFixtureCSS(library(packaged([{ fileName: 'theme.css', type: 'css', text: 42 }]))), /filename and text/);
});

test('accepts exactly 64 KiB and rejects excess bytes including separators and Unicode', () => {
  assert.equal(selectFixtureCSS(library(record({ sourceText: 'x'.repeat(MAX_COMBINED_CSS_BYTES) }))).cssBytes, MAX_COMBINED_CSS_BYTES);
  assert.throws(() => selectFixtureCSS(library(record({ sourceText: 'x'.repeat(MAX_COMBINED_CSS_BYTES + 1) }))), /combined 64 KiB/);
  assert.throws(() => selectFixtureCSS(library(
    record({ sourceText: 'x'.repeat(MAX_COMBINED_CSS_BYTES) }),
    record({ id: 'second', sourceText: '' })
  )), /combined 64 KiB/);
  assert.throws(() => selectFixtureCSS(library(record({ sourceText: 'é'.repeat(MAX_COMBINED_CSS_BYTES / 2 + 1) }))), /combined 64 KiB/);
});

test('no enabled content and whitespace-only content do not request a debug launch', () => {
  const empty = selectFixtureCSS(library());
  assert.equal(empty.hasCSS, false);
  assert.equal(empty.css, '');
  assert.equal(empty.cssBytes, 0);
  assert.deepEqual(empty.enabledExtensionIDs, []);
  assert.equal(selectFixtureCSS(library(record({ sourceText: ' \n\t' }))).hasCSS, false);
});

test('revision changes follow selected CSS and order without reacting to unrelated logs', () => {
  const first = record();
  const second = record({ id: 'second', sourceText: 'a { color: blue; }' });
  const baseline = selectFixtureCSS(library(first, second));
  assert.equal(selectFixtureCSS({ records: [first, second], logs: [{ message: 'new log' }] }).revisionKey, baseline.revisionKey);
  assert.equal(selectFixtureCSS(library(first, second, record({ appKey: 'other', id: 'other' }))).revisionKey, baseline.revisionKey);
  assert.notEqual(selectFixtureCSS(library(second, first)).revisionKey, baseline.revisionKey);
  assert.notEqual(selectFixtureCSS(library({ ...first, sourceText: 'a { color: pink; }' }, second)).revisionKey, baseline.revisionKey);
});

test('ChatGPT selection is isolated to its fixed app key and leaves other or disabled scripts inert', () => {
  assert.equal(CHATGPT_APP_KEY, 'com.openai.codex');
  const selected = record({ appKey: CHATGPT_APP_KEY, sourceText: '.voice { display: none; }' });
  const fixture = record({ id: 'fixture', sourceText: '.fixture { color: green; }' });
  const disabledScript = record({ appKey: CHATGPT_APP_KEY, id: 'disabled', isEnabled: false, sourceType: 'js' });
  const otherScript = record({ appKey: 'example.other', id: 'other', sourceType: 'js' });
  const input = library(fixture, selected, disabledScript, otherScript);
  const result = selectChatGPTCSS(JSON.stringify(input));
  assert.equal(result.css, selected.sourceText);
  assert.deepEqual(result.enabledExtensionIDs, [selected.id]);
  assert.equal(result.hasCSS, true);
  assert.equal(selectFixtureCSS(input).css, fixture.sourceText);
  assert.equal(selectChatGPTCSS(library({ ...fixture, sourceType: 'js' })).hasCSS, false);
  assert.equal(selectFixtureCSS(library({ ...selected, sourceType: 'js' })).hasCSS, false);
  assert.equal(selectChatGPTCSS(library()).hasCSS, false);
  assert.equal(selectChatGPTCSS(library({ ...selected, sourceText: ' \n\t' })).hasCSS, false);
});

test('ChatGPT shares CSS validation and identifies its own unsupported sources in errors', () => {
  const chatGPT = overrides => record({ appKey: CHATGPT_APP_KEY, ...overrides });
  assert.throws(() => selectChatGPTCSS(library(chatGPT({ sourceType: 'js' }))), /ChatGPT Dock broker.*Disable the JS extension/);
  const mixed = { ...packaged([
    { fileName: 'theme.css', type: 'css', text: 'a {}' },
    { fileName: 'behavior.js', type: 'js', text: 'not executed' }
  ]), appKey: CHATGPT_APP_KEY };
  assert.throws(() => selectChatGPTCSS(library(mixed)), /ChatGPT Dock broker.*mixed CSS\/JS extension/);
  assert.equal(selectChatGPTCSS(library({ ...mixed, isEnabled: false })).hasCSS, false);
  assert.throws(() => selectChatGPTCSS(library(chatGPT(), chatGPT())), /enabled ChatGPT records need unique IDs/);
  assert.throws(() => selectChatGPTCSS(library(chatGPT({ sourceType: 'unknown' }))), /enabled ChatGPT record has an unknown source type/);
  for (const input of ['{', null, [], {}, { records: {} }, library(null), library(chatGPT({ isEnabled: 'yes' }))]) {
    assert.throws(() => selectChatGPTCSS(input), /Invalid extension library/);
  }
  for (const changes of [
    { id: '' }, { name: '' }, { sourceText: null }, { sourceFileName: 'theme.js' },
    { sourceFiles: [] }, { sourceFiles: {} }
  ]) assert.throws(() => selectChatGPTCSS(library(chatGPT(changes))), /Invalid extension library/);
  const source = { fileName: 'theme.css', type: 'css', text: 'a {}' };
  assert.throws(() => selectChatGPTCSS(library({ ...packaged([source, source]), appKey: CHATGPT_APP_KEY })), /filenames must be unique/);
  assert.throws(() => selectChatGPTCSS(library({ ...packaged([source]), appKey: CHATGPT_APP_KEY, sourceText: 'different {}' })), /first-source fields disagree/);
});

test('ChatGPT preserves cascade, revision and UTF-8 size rules including separator bytes', () => {
  const first = { ...packaged([
    { fileName: 'base.css', type: 'css', text: '/* café */ a { color: red; }' },
    { fileName: 'override.css', type: 'css', text: 'a { color: blue; }' }
  ]), appKey: CHATGPT_APP_KEY };
  const second = record({ appKey: CHATGPT_APP_KEY, id: 'second', sourceText: 'a { color: green; }' });
  const result = selectChatGPTCSS(library(first, second));
  assert.equal(result.css, first.sourceFiles.map(source => source.text).concat(second.sourceText).join('\n'));
  assert.deepEqual(result.sources.map(source => source.fileName), ['base.css', 'override.css', 'green.css']);
  assert.deepEqual(result.enabledExtensionIDs, ['first', 'second']);
  assert.equal(result.cssBytes, Buffer.byteLength(result.css, 'utf8'));
  assert.equal(selectChatGPTCSS({ ...library(first, second), logs: ['changed'] }).revisionKey, result.revisionKey);
  assert.equal(selectChatGPTCSS(library(first, second, record())).revisionKey, result.revisionKey);
  assert.notEqual(selectChatGPTCSS(library(second, first)).revisionKey, result.revisionKey);
  assert.notEqual(selectChatGPTCSS(library(first, { ...second, sourceText: 'a {}' })).revisionKey, result.revisionKey);
  const full = { ...second, sourceText: 'x'.repeat(MAX_COMBINED_CSS_BYTES) };
  assert.equal(selectChatGPTCSS(library(full)).cssBytes, MAX_COMBINED_CSS_BYTES);
  for (const records of [
    [{ ...full, sourceText: full.sourceText + 'x' }],
    [full, { ...second, id: 'empty', sourceText: '' }],
    [{ ...second, sourceText: 'é'.repeat(MAX_COMBINED_CSS_BYTES / 2 + 1) }]
  ]) assert.throws(() => selectChatGPTCSS(library(...records)), /Enabled ChatGPT stylesheets exceed the combined 64 KiB/);
});

test('fixed file readers select their own stored sources without reading source filenames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dock-library-test-'));
  try {
    const file = join(directory, 'library.json');
    const fixture = record({ sourceFileName: '/nonexistent/fixture.css' });
    const chatGPT = record({ appKey: CHATGPT_APP_KEY, sourceFileName: '/nonexistent/chatgpt.css', sourceText: '.voice { display: none; }' });
    const input = library(fixture, chatGPT);
    await writeFile(file, JSON.stringify(input));
    assert.deepEqual(await readDockLibrary(file), selectFixtureCSS(input));
    assert.deepEqual(await readChatGPTDockLibrary(file), selectChatGPTCSS(input));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('both fixed readers reject malformed, non-UTF-8, oversized and non-file libraries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dock-library-test-'));
  try {
    const file = join(directory, 'library.json');
    for (const read of [readDockLibrary, readChatGPTDockLibrary]) {
      await writeFile(file, '{');
      await assert.rejects(read(file), /expected valid JSON/);
      await writeFile(file, Buffer.from([0xff]));
      await assert.rejects(read(file), /must be UTF-8/);
      const handle = await open(file, 'w');
      try { await handle.truncate(64 * 1024 * 1024 + 1); }
      finally { await handle.close(); }
      await assert.rejects(read(file), /regular library file no larger than 64 MiB/);
      await assert.rejects(read(directory), /regular library file no larger than 64 MiB/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
