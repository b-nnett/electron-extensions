import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectChatGPTExtensions, readChatGPTExtensions, uniqueChatGPTTarget,
  chatGPTRendererPage, applyChatGPTSources, chatGPTTerminalStatus, confirmChatGPTApplication } from '../lib/chatgpt-extensions.mjs';
import { ChatGPTStylesheet } from '../lib/chatgpt-stylesheet.mjs';
import { chatGPTOutputDirectory } from '../scripts/dock-chatgpt-session.mjs';

const id = '12345678-1234-5678-1234-567812345678';
const record = (overrides = {}) => ({ id, appKey: 'com.openai.codex', name: 'Owned behavior', isEnabled: true,
  sourceFileName: 'behavior.js', sourceType: 'js', sourceText: "console.log('owned');", ...overrides });
const state = (overrides = {}) => ({ extensionID: id, revision: 'r1', phase: 'active', generation: 1,
  cleanupComplete: false, reloadBlocked: false, fileNames: ['behavior.js'], ...overrides });
const target = { id: 'desktop-one', type: 'page', url: 'app://-/index.html' };

class Renderer extends EventEmitter {
  url = target.url; css = ''; sheets = 0;
  async call(method, params = {}) {
    switch (method) {
      case 'Page.enable': case 'DOM.enable': case 'CSS.enable': return {};
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main', url: this.url } } };
      case 'DOM.getDocument': return { root: { nodeId: 1 } };
      case 'DOM.querySelectorAll': return { nodeIds: [] }; // General scripts need no Voice control.
      case 'CSS.createStyleSheet': return { styleSheetId: `sheet-${++this.sheets}` };
      case 'CSS.setStyleSheetText': this.css = params.text; return {};
      case 'CSS.getStyleSheetText': return { text: this.css };
      default: assert.fail(`Unexpected method ${method}`);
    }
  }
}

test('ChatGPT mixed selector admits JS-only, CSS-only and mixed selected records within shared bounds', () => {
  const js = record(), css = record({ id: '22345678-1234-5678-1234-567812345678', sourceFileName: 'appearance.css', sourceType: 'css', sourceText: '.owned { color: green; }' });
  for (const records of [[js], [css], [js, css]]) {
    const selected = selectChatGPTExtensions({ records: [...records, record({ appKey: 'another.app' })] });
    assert.equal(selected.hasContent, true); assert.equal(selected.extensions.length, records.length);
    assert.equal(selected.jsExtensions.length, records.includes(js) ? 1 : 0);
    assert.equal(selected.hasCSS, records.includes(css));
  }
  assert.equal(selectChatGPTExtensions({ records: [record({ isEnabled: false })] }).hasContent, false);
  assert.throws(() => selectChatGPTExtensions({ records: [record({ sourceText: 'x'.repeat(256 * 1024 + 1) })] }), /256 KiB/);
  assert.throws(() => selectChatGPTExtensions({ records: [js, js] }), /unique UUID/);
});

test('ChatGPT library read is bounded, regular and refuses symlinks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ea-chatgpt-library-'));
  try {
    const file = path.join(directory, 'library.json'), link = path.join(directory, 'linked.json');
    await writeFile(file, JSON.stringify({ records: [record()] }));
    assert.equal((await readChatGPTExtensions(file)).jsExtensions.length, 1);
    await symlink(file, link);
    await assert.rejects(readChatGPTExtensions(link));
    await assert.rejects(readChatGPTExtensions(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('selected ChatGPT document must stay unique and retain its pinned target identity', () => {
  assert.equal(uniqueChatGPTTarget([target], target.id), target);
  assert.equal(uniqueChatGPTTarget([]), undefined);
  assert.throws(() => uniqueChatGPTTarget([target, { ...target, id: 'other' }]), /More than one/);
  for (const url of ['https://chatgpt.com/', 'app://-/settings.html', 'app://elsewhere/index.html', 'app://user@-/index.html']) {
    assert.throws(() => uniqueChatGPTTarget([{ ...target, url }], target.id), /disappeared/);
  }
  assert.throws(() => uniqueChatGPTTarget([{ ...target, id: 'replacement' }], target.id), /identity/);
  assert.throws(() => uniqueChatGPTTarget({}), /Invalid/);
  assert.throws(() => uniqueChatGPTTarget(Array(257).fill(target)), /Invalid/);
});

test('ChatGPT page wrapper permits only renderer methods, checks every owner and forbids privileged evaluation', async () => {
  const transport = new EventEmitter(), calls = []; let owned = true;
  transport.call = async (method, params) => { calls.push({ method, params }); return {}; };
  const page = chatGPTRendererPage(transport, async () => { if (!owned) throw new Error('owner changed'); });
  for (const method of ['Browser.close', 'Target.attachToTarget', 'Page.reload', 'Runtime.addBinding', 'Network.getCookies']) {
    await assert.rejects(page.call(method), /not allowed/);
  }
  await assert.rejects(page.call('Runtime.evaluate', { expression: '1' }), /CSP/);
  await assert.rejects(page.call('Page.createIsolatedWorld', { grantUniveralAccess: true }), /universal/);
  await assert.rejects(page.call('Page.createIsolatedWorld', { grantUniveralAccess: false, grantUniversalAccess: true }), /universal/);
  assert.equal(calls.length, 0);
  await page.call('Runtime.evaluate', { expression: '1', allowUnsafeEvalBlockedByCSP: false });
  await page.call('Page.createIsolatedWorld', { frameId: 'main', grantUniveralAccess: false });
  assert.equal(calls.length, 2);
  owned = false; await assert.rejects(page.call('CSS.enable'), /owner changed/);
  assert.equal(calls.length, 2);
  let forwarded = false; page.on('Runtime.executionContextDestroyed', value => { forwarded = value.executionContextId === 2; });
  transport.emit('Runtime.executionContextDestroyed', { executionContextId: 2 }); assert.equal(forwarded, true);
});

test('ChatGPT mixed apply replaces CSS, supports a page without Voice, and reapplies after navigation', async () => {
  const renderer = new Renderer(), styles = new ChatGPTStylesheet(renderer, async () => {});
  await styles.init(); const seen = [];
  const scripts = { sync: async records => { seen.push(records); return records.length ? [state()] : []; } };
  const selected = selectChatGPTExtensions({ records: [record(), record({ id: '22345678-1234-5678-1234-567812345678', sourceFileName: 'a.css', sourceType: 'css', sourceText: '.owned { color: green; }' })] });
  assert.equal((await applyChatGPTSources(styles, scripts, selected)).phase, 'active');
  assert.equal(renderer.css, selected.css); assert.equal(renderer.sheets, 1);
  renderer.emit('Page.frameNavigated', { frame: { id: 'main', url: renderer.url } });
  await applyChatGPTSources(styles, scripts, selected); assert.equal(renderer.sheets, 2);
  const disabled = await applyChatGPTSources(styles, scripts, selectChatGPTExtensions({ records: [] }));
  assert.equal(disabled.phase, 'disabled'); assert.equal(renderer.css, ''); assert.deepEqual(seen.at(-1), []);
  await styles.dispose(); assert.equal(renderer.listenerCount('Page.frameNavigated'), 0);
});

test('a recoverable script failure keeps CSS and its attributed failure state; unresolved cleanup remains fatal', async () => {
  let css;
  const styles = { set: async value => { css = value; return { matches: 0, display: null }; } };
  const selection = { hasCSS: true, hasContent: true, css: '.owned{}', jsExtensions: [{}] };
  const failed = state({ phase: 'failed', cleanupComplete: true, lastError: { fileName: 'behavior.js', stage: 'initialize' } });
  const error = Object.assign(new Error('script failed'), { states: [failed] });
  const scripts = { sync: async () => { throw error; } };
  const result = await applyChatGPTSources(styles, scripts, selection);
  assert.equal(css, selection.css); assert.equal(result.phase, 'error'); assert.equal(result.jsStates[0].phase, 'failed');
  failed.reloadBlocked = true;
  await assert.rejects(applyChatGPTSources(styles, scripts, selection), /script failed/);
});

test('terminal ChatGPT state clears live extension and endpoint claims without erasing cleanup errors', () => {
  const result = chatGPTTerminalStatus({ errors: ['cleanup unresolved'] });
  assert.equal(result.phase, 'error'); assert.equal(result.error, 'cleanup unresolved');
  assert.equal(result.pid, null); assert.equal(result.port, null);
  assert.equal(result.cssBytes, 0); assert.equal(result.jsBytes, 0);
  assert.deepEqual(result.jsStates, []); assert.deepEqual(result.enabledExtensionIDs, []);
});

test('ChatGPT application acknowledgment refuses changed library and document snapshots after asynchronous work', async () => {
  const selection = { revisionKey: 'first' }, styles = { generation: 1, needsUpdate: false };
  const args = { selection, styles, generation: 1, stopped: () => false, readSelection: async () => selection };
  assert.equal(await confirmChatGPTApplication(args), true);
  assert.equal(await confirmChatGPTApplication({ ...args, readSelection: async () => ({ revisionKey: 'disabled-after-integrity' }) }), false);
  assert.equal(await confirmChatGPTApplication({ ...args, readSelection: async () => { styles.generation++; return selection; } }), false);
  styles.generation = 1;
  let stopped = false;
  assert.equal(await confirmChatGPTApplication({ ...args, stopped: () => stopped,
    readSelection: async () => { stopped = true; return selection; } }), false);
  styles.needsUpdate = true;
  assert.equal(await confirmChatGPTApplication({ ...args, readSelection: async () => assert.fail('no stale document read') }), false);
});

test('mixed source result keeps the CSS document generation when JavaScript yields across navigation', async () => {
  const styles = { generation: 4, set: async () => ({ matches: 0, display: null }) };
  const scripts = { sync: async () => { styles.generation = 5; return [state()]; } };
  const result = await applyChatGPTSources(styles, scripts, selectChatGPTExtensions({ records: [record()] }));
  assert.equal(result.generation, 4);
  assert.equal(await confirmChatGPTApplication({ selection: { revisionKey: 'r' }, styles, generation: result.generation,
    stopped: () => false, readSelection: async () => assert.fail('no stale acknowledgement') }), false);
});

test('ChatGPT output admission preserves an old extension-log-only directory and accepts native startup markers', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ea-chatgpt-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await chatGPTOutputDirectory(path.join(directory, 'session'));
  await writeFile(path.join(output, 'launcher.log'), 'startup');
  await writeFile(path.join(output, '.ea-session-owner.json'), '{}');
  assert.equal(await chatGPTOutputDirectory(output), output);
  const oldLog = path.join(output, 'extension-logs.json');
  await writeFile(oldLog, 'preserved old output');
  await assert.rejects(chatGPTOutputDirectory(output), /previous session files are preserved/);
  assert.equal(await readFile(oldLog, 'utf8'), 'preserved old output');
  const bundle = path.join(directory, 'Target.app'), alias = path.join(directory, 'alias');
  await mkdir(bundle);
  await symlink(bundle, alias);
  await assert.rejects(chatGPTOutputDirectory(path.join(bundle, 'session')), /outside application bundles/);
  await assert.rejects(chatGPTOutputDirectory(path.join(alias, 'session')), /outside application bundles/);
});
