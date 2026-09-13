import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChatGPTStylesheet, isChatGPTAppPage } from '../lib/chatgpt-stylesheet.mjs';

class Renderer extends EventEmitter {
  text = '';
  calls = [];
  duringReadback = () => {};
  async call(method, params = {}) {
    this.calls.push({ method, params });
    switch (method) {
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main', url: 'app://-/index.html' } } };
      case 'CSS.createStyleSheet': return { styleSheetId: 'owned' };
      case 'CSS.setStyleSheetText': this.text = params.text; return {};
      case 'CSS.getStyleSheetText': this.duringReadback(); return { text: this.text };
      case 'DOM.getDocument': return { root: { nodeId: 1 } };
      case 'DOM.querySelectorAll': return { nodeIds: [2] };
      case 'CSS.getComputedStyleForNode': return { computedStyle: [{ name: 'display', value: this.text ? 'none' : 'inline-block' }] };
      default: return {};
    }
  }
}

test('restricts styling to the packaged desktop page, including its origin', () => {
  assert.equal(isChatGPTAppPage('app://-/index.html?initialRoute=%2F#chat'), true);
  for (const url of ['https://chatgpt.com/', 'app://fs/index.html', 'app://-/other.html',
    'app://-:123/index.html', 'app://user@-/index.html', 'file:///index.html', 'not a url']) {
    assert.equal(isChatGPTAppPage(url), false, url);
  }
});

test('navigation during readback cannot acknowledge a lost stylesheet', async () => {
  const renderer = new Renderer();
  const styles = new ChatGPTStylesheet(renderer, async () => {});
  renderer.duringReadback = () => renderer.emit('Page.frameNavigated', { frame: { id: 'next' } });
  await assert.rejects(styles.set('button { display: none; }'), /navigated during/);
  assert.equal(styles.needsUpdate, true);
  assert.equal(styles.sheet, null);
});

test('a cancelled controller prevents new CSS while still allowing removal', async () => {
  const renderer = new Renderer();
  let stopped = false;
  const styles = new ChatGPTStylesheet(renderer, async () => {}, () => { if (stopped) throw new Error('stopped'); });
  await styles.set('button { display: none; }');
  stopped = true;
  await assert.rejects(styles.set('button { color: green; }'), /stopped/);
  assert.equal(renderer.text, 'button { display: none; }');
  await styles.dispose();
  assert.equal(renderer.text, '');
  assert.equal(renderer.listenerCount('Page.frameNavigated'), 0);
});

test('navigation during disposal cannot report removal from a replacement document', async () => {
  const renderer = new Renderer();
  const styles = new ChatGPTStylesheet(renderer, async () => {});
  await styles.set('button { color: green; }');
  renderer.duringReadback = () => renderer.emit('Page.frameNavigated', { frame: { id: 'next' } });
  await assert.rejects(styles.dispose(), /navigated during/);
  assert.equal(renderer.listenerCount('Page.frameNavigated'), 0);
});
