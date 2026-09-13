import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export const FIXTURE_APP_KEY = 'dev.extensionsanywhere.stylelab';
export const CHATGPT_APP_KEY = 'com.openai.codex';
export const MAX_COMBINED_CSS_BYTES = 64 * 1024;
export const MAX_FIXTURE_JS_BYTES = 256 * 1024;
const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;
const FIXTURE_PROFILE = { appKey: FIXTURE_APP_KEY, name: 'Style Lab', recordLabel: 'fixture' };
const CHATGPT_PROFILE = { appKey: CHATGPT_APP_KEY, name: 'ChatGPT', recordLabel: 'ChatGPT' };

const invalid = message => new Error(`Invalid extension library: ${message}`);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Selects stored text only. Source filenames are labels, never paths to read. */
export function selectFixtureCSS(library) {
  return selectCSS(library, FIXTURE_PROFILE);
}

/** Imported execution is available only for the owned fixture. Other selectors
 * intentionally keep their existing CSS-only behavior and launch guards. */
export function selectFixtureExtensions(library) {
  return selectRendererExtensions(library, FIXTURE_PROFILE);
}

export function selectRendererExtensions(library, profile) {
  if (!profile || !text(profile.appKey) || !text(profile.name)) throw invalid("a fixed renderer identity is required.");
  if (typeof library === 'string') {
    try { library = JSON.parse(library); } catch { throw invalid('expected valid JSON.'); }
  }
  if (!object(library) || !Array.isArray(library.records)) throw invalid('records must be an array.');
  const extensions = [], sources = [], parts = [], jsExtensions = [], ids = new Set();
  let cssBytes = 0, jsBytes = 0;
  for (const record of library.records) {
    if (!object(record) || !text(record.appKey) || typeof record.isEnabled !== 'boolean') {
      throw invalid('each record needs an appKey and boolean isEnabled.');
    }
    if (record.appKey !== profile.appKey || !record.isEnabled) continue;
    if (!text(record.id) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id) ||
        ids.has(record.id.toLowerCase()) || !text(record.name)) throw invalid(`enabled ${profile.recordLabel ?? profile.name} records need unique UUID IDs and names.`);
    ids.add(record.id.toLowerCase());
    if (ids.size > 64) throw invalid(`use at most 64 enabled ${profile.recordLabel ?? profile.name} records.`);
    const packaged = record.sourceFiles != null;
    const files = packaged ? record.sourceFiles : [{ fileName: record.sourceFileName, type: record.sourceType, text: record.sourceText }];
    if (!Array.isArray(files) || !files.length || files.length > 32) throw invalid('use one to 32 files per fixture extension.');
    const names = new Set(), scripts = [];
    for (const source of files) {
      if (!object(source) || typeof source.fileName !== 'string' || !source.fileName.length ||
          Buffer.byteLength(source.fileName, 'utf8') > 256 || /[\\:\u0000-\u001f\u007f-\u009f]/.test(source.fileName) ||
          source.fileName.split('/').some(part => !part || part === '.' || part === '..') ||
          !['css', 'js'].includes(source.type) || !source.fileName.toLowerCase().endsWith(`.${source.type}`) ||
          typeof source.text !== 'string') throw invalid('each fixture source needs a contained CSS/JS filename and text.');
      if (names.has(source.fileName)) throw invalid('source filenames must be unique within an extension.');
      names.add(source.fileName);
      const bytes = Buffer.byteLength(source.text, 'utf8');
      if (source.type === 'css') {
        cssBytes += bytes + (parts.length ? 1 : 0);
        if (cssBytes > MAX_COMBINED_CSS_BYTES) throw new Error(`Enabled ${profile.name} stylesheets exceed the combined 64 KiB limit.`);
        parts.push(source.text);
        sources.push({ extensionID: record.id, fileName: source.fileName, bytes });
      } else {
        jsBytes += bytes;
        if (jsBytes > MAX_FIXTURE_JS_BYTES) throw new Error(`Enabled ${profile.name} scripts exceed the combined 256 KiB limit.`);
        scripts.push({ fileName: source.fileName, text: source.text });
      }
    }
    if (packaged && (record.sourceText !== files[0].text || record.sourceType !== files[0].type ||
        record.sourceFileName !== files[0].fileName.split('/').at(-1))) throw invalid('package and legacy first-source fields disagree.');
    extensions.push({ id: record.id, name: record.name });
    if (scripts.length) jsExtensions.push({ extensionID: record.id,
      revision: createHash('sha256').update(JSON.stringify(scripts)).digest('hex'), files: scripts });
  }
  const css = parts.join('\n');
  const sha256 = createHash('sha256').update(css).digest('hex');
  const revisionKey = createHash('sha256').update(JSON.stringify({ extensions, sources, sha256,
    scripts: jsExtensions.map(({ extensionID, revision }) => ({ extensionID, revision })) })).digest('hex');
  const hasCSS = css.trim().length > 0;
  const hasContent = hasCSS || jsExtensions.some(extension => extension.files.some(file => file.text.trim().length > 0));
  if (extensions.length && !hasContent) throw invalid('enabled fixture extensions contain only empty or whitespace source.');
  return { css, cssBytes, sha256, revisionKey, sources, extensions, hasCSS,
    enabledExtensionIDs: extensions.map(record => record.id), jsBytes, jsExtensions,
    hasContent };
}

export function selectChatGPTCSS(library) {
  return selectCSS(library, CHATGPT_PROFILE);
}

function selectCSS(library, profile) {
  if (typeof library === 'string') {
    try { library = JSON.parse(library); } catch { throw invalid('expected valid JSON.'); }
  }
  if (!object(library) || !Array.isArray(library.records)) throw invalid('records must be an array.');
  const selected = [], sources = [], parts = [], ids = new Set();
  let cssBytes = 0;
  for (const record of library.records) {
    if (!object(record) || !text(record.appKey) || typeof record.isEnabled !== 'boolean') {
      throw invalid('each record needs an appKey and boolean isEnabled.');
    }
    if (record.appKey !== profile.appKey || !record.isEnabled) continue;
    if (!text(record.id) || ids.has(record.id) || !text(record.name)) throw invalid(`enabled ${profile.recordLabel} records need unique IDs and names.`);
    ids.add(record.id);
    if (record.sourceType === 'js') throw new Error(`JavaScript extensions are not supported by the ${profile.name} Dock broker. Disable the JS extension before launching.`);
    if (record.sourceType !== 'css') throw invalid(`an enabled ${profile.recordLabel} record has an unknown source type.`);
    const packageSources = record.sourceFiles != null;
    const files = packageSources ? record.sourceFiles : [
      { fileName: record.sourceFileName, type: record.sourceType, text: record.sourceText }
    ];
    if (!Array.isArray(files) || files.length === 0) throw invalid('sourceFiles must be a nonempty array.');
    const fileNames = new Set();
    for (const source of files) {
      if (!object(source) || !text(source.fileName) || typeof source.text !== 'string') throw invalid('each source needs a filename and text.');
      if (source.type === 'js') throw new Error(`JavaScript extensions are not supported by the ${profile.name} Dock broker. Disable the mixed CSS/JS extension before launching.`);
      if (source.type !== 'css' || !source.fileName.toLowerCase().endsWith('.css')) throw invalid('an enabled source is not CSS.');
      if (fileNames.has(source.fileName)) throw invalid('source filenames must be unique within an extension.');
      fileNames.add(source.fileName);
      const bytes = Buffer.byteLength(source.text, 'utf8');
      cssBytes += bytes + (parts.length ? 1 : 0);
      if (cssBytes > MAX_COMBINED_CSS_BYTES) throw new Error(`Enabled ${profile.name} stylesheets exceed the combined 64 KiB limit.`);
      parts.push(source.text);
      sources.push({ extensionID: record.id, fileName: source.fileName, bytes });
    }
    // Current packages repeat their first file in the legacy fields. A mismatch
    // indicates corrupt data; never apply a different source accidentally.
    if (packageSources && (record.sourceText !== files[0].text || record.sourceType !== files[0].type)) {
      throw invalid('package and legacy first-source fields disagree.');
    }
    selected.push({ id: record.id, name: record.name });
  }
  const css = parts.join('\n');
  const sha256 = createHash('sha256').update(css).digest('hex');
  const revisionKey = createHash('sha256').update(JSON.stringify({ selected, sources, sha256 })).digest('hex');
  return {
    css, cssBytes, sha256, revisionKey, sources,
    enabledExtensionIDs: selected.map(record => record.id),
    extensions: selected,
    hasCSS: selected.length > 0 && css.trim().length > 0
  };
}

export async function readDockLibrary(file) {
  return readLibrary(file, FIXTURE_PROFILE);
}

export async function readFixtureExtensionLibrary(file) {
  return readLibrary(file, FIXTURE_PROFILE, selectFixtureExtensions);
}

export async function readChatGPTDockLibrary(file) {
  return readLibrary(file, CHATGPT_PROFILE);
}

async function readLibrary(file, profile, selector = source => selectCSS(source, profile)) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_LIBRARY_BYTES) throw invalid('use a regular library file no larger than 64 MiB.');
    const chunks = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_LIBRARY_BYTES + 1 - bytes));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
      if (bytes > MAX_LIBRARY_BYTES) throw invalid('the library exceeds 64 MiB.');
    }
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw invalid('the library must be UTF-8.'); }
    return selector(source);
  } finally { await handle.close(); }
}
