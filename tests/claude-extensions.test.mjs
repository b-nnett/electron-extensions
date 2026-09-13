import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { selectClaudeExtensions, parseClaudeRegistry, InspectorRendererStylesheet, CLAUDE_APP_KEY, CLAUDE_BUNDLE, CLAUDE_PAGE } from '../lib/claude-extensions.mjs';
import { parseClaudeOptions, claudeInspectorListener, claudeInspectorEndpoint } from '../scripts/dock-claude-session.mjs';
const id = '12345678-1234-5678-1234-567812345678';
const record = changes => ({ id, appKey: CLAUDE_APP_KEY, name: 'Owned example', isEnabled: true, sourceFileName: 'main.js', sourceType: 'js', sourceText: 'console.log("owned")', ...changes });
test('Claude mixed selection is target-bound and keeps shared source and identity limits', () => {
  const selected = selectClaudeExtensions({ records: [record(), record({ appKey: 'other.app' })] });
  assert.equal(selected.jsExtensions.length, 1); assert.equal(selected.hasContent, true); assert.equal(selected.hasCSS, false);
  assert.equal(selectClaudeExtensions({ records: [record({ isEnabled: false })] }).hasContent, false);
  assert.throws(() => selectClaudeExtensions({ records: [record(), record()] }), /UUID/);
  assert.throws(() => selectClaudeExtensions({ records: [record({ sourceText: 'x'.repeat(256 * 1024 + 1) })] }), /256 KiB/);
});
test('Claude CLI provides no port, executable, route or target override', () => {
  assert.deepEqual(parseClaudeOptions(['--library', '/tmp/library.json', '--output', '/tmp/session']), { library: '/tmp/library.json', output: '/tmp/session' });
  for (const input of [[], ['--library', 'relative', '--output', '/tmp/session'], ['--library', '/tmp/a', '--output', '/tmp/b', '--port', '9229'], ['--library', '/tmp/a', '--library', '/tmp/b']]) assert.throws(() => parseClaudeOptions(input));
});
test('Claude adoption requires one registry result with the exact app identity and path', () => {
  const running = { pid: 42, bundleIdentifier: CLAUDE_APP_KEY, bundlePath: CLAUDE_BUNDLE };
  assert.equal(parseClaudeRegistry([]), null); assert.equal(parseClaudeRegistry([running]), running);
  for (const values of [[running, running], [{ ...running, bundlePath: '/tmp/Claude.app' }], [{ ...running, bundleIdentifier: 'other' }], [{ ...running, pid: 0 }], {}]) assert.throws(() => parseClaudeRegistry(values));
});
test('Claude inspector must be the sole selected-process IPv4 loopback listener', () => {
  assert.equal(claudeInspectorListener('p42\nf12\nn127.0.0.1:9229\n', 42), true);
  for (const value of ['p43\nn127.0.0.1:9229\n', 'p42\nn*:9229\n', 'p42\nn[::1]:9229\n', 'p42\nn127.0.0.1:9229\np43\nn127.0.0.1:9229\n', 'p42\nn127.0.0.1:9229\nn127.0.0.1:9229\n']) assert.equal(claudeInspectorListener(value, 42), false);
});
test('Claude inspector metadata is one fixed-port Node UUID endpoint with no credentials or redirects', () => {
  const target = { type: 'node', webSocketDebuggerUrl: `ws://127.0.0.1:9229/${id}` };
  assert.equal(claudeInspectorEndpoint([target]), target.webSocketDebuggerUrl);
  for (const targets of [[], [target, target], [{ ...target, type: 'page' }], [{ ...target, webSocketDebuggerUrl: `ws://localhost:9229/${id}` }], [{ ...target, webSocketDebuggerUrl: `ws://user@127.0.0.1:9229/${id}` }], [{ ...target, webSocketDebuggerUrl: `ws://127.0.0.1:9229/${id}?x` }]]) assert.throws(() => claudeInspectorEndpoint(targets));
});
test('Claude CSS confirmation is stylesheet readback and keeps navigation observed through removal', async () => {
  const page = new EventEmitter(); let text = '', navigateOnClear = false;
  page.call = async (method, params) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: CLAUDE_PAGE } } };
    if (method === 'CSS.createStyleSheet') return { styleSheetId: 'owned' };
    if (method === 'CSS.setStyleSheetText') { text = params.text; if (!text && navigateOnClear) page.emit('Page.frameNavigated', { frame: { id: 'next' } }); }
    if (method === 'CSS.getStyleSheetText') return { text };
    return {};
  };
  const styles = new InspectorRendererStylesheet(page, url => url === CLAUDE_PAGE); await styles.init();
  assert.equal((await styles.set('button{color:green}')).stylesheetReadbackVerified, true);
  navigateOnClear = true; await assert.rejects(styles.dispose(), /navigated/); assert.equal(page.listenerCount('Page.frameNavigated'), 0);
});
test('a stopped Claude broker cannot apply queued nonempty CSS, but can still remove its stylesheet', async () => {
  const page = new EventEmitter(); let text = '', stopped = false;
  page.call = async (method, params) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: CLAUDE_PAGE } } };
    if (method === 'CSS.createStyleSheet') return { styleSheetId: 'owned' };
    if (method === 'CSS.setStyleSheetText') text = params.text;
    if (method === 'CSS.getStyleSheetText') return { text };
    return {};
  };
  const styles = new InspectorRendererStylesheet(page, url => url === CLAUDE_PAGE, () => { if (stopped) throw new Error('stopped'); });
  await styles.init(); await styles.set('button{color:green}'); stopped = true;
  await assert.rejects(styles.set('button{color:red}'), /stopped/); assert.equal(text, 'button{color:green}');
  await styles.dispose(); assert.equal(text, '');
});
