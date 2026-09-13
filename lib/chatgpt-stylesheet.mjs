// A stylesheet in the selected ChatGPT desktop renderer only. No JavaScript
// evaluation, main-process commands, browser-page styling, or target discovery.
export const CHATGPT_VOICE_SELECTOR = '.h-toolbar button[aria-label="Start new voice chat"]';

export function isChatGPTAppPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === '-' && !url.port &&
      !url.username && !url.password && url.pathname === '/index.html';
  } catch { return false; }
}

export class ChatGPTStylesheet {
  constructor(cdp, requireOwner, beforeWrite = () => {}) {
    this.cdp = cdp;
    this.requireOwner = requireOwner;
    this.beforeWrite = beforeWrite;
    this.generation = 0;
    this.sheet = null;
    this.needsUpdate = true;
    this.onNavigation = ({ frame }) => {
      if (!frame.parentId) { this.generation++; this.sheet = null; this.needsUpdate = true; }
    };
    cdp.on('Page.frameNavigated', this.onNavigation);
  }

  async init() {
    await this.requireOwner();
    await this.cdp.call('Page.enable');
    await this.cdp.call('DOM.enable');
    await this.cdp.call('CSS.enable');
    await this.frame();
  }

  async frame() {
    await this.requireOwner();
    const { frameTree } = await this.cdp.call('Page.getFrameTree');
    if (!isChatGPTAppPage(frameTree?.frame?.url)) {
      throw new Error('The selected window is not the packaged ChatGPT desktop page. No stylesheet was applied.');
    }
    return frameTree.frame;
  }

  async voice() {
    await this.frame();
    const { root } = await this.cdp.call('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await this.cdp.call('DOM.querySelectorAll', {
      nodeId: root.nodeId, selector: CHATGPT_VOICE_SELECTOR
    });
    if (nodeIds.length !== 1) return { matches: nodeIds.length, display: null };
    const { computedStyle } = await this.cdp.call('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] });
    return { matches: 1, display: computedStyle.find(item => item.name === 'display')?.value ?? null };
  }

  async set(css) {
    if (typeof css !== 'string' || Buffer.byteLength(css, 'utf8') > 64 * 1024) {
      throw new Error('ChatGPT stylesheets must total 64 KiB or less.');
    }
    const generation = this.generation;
    const requireDocument = () => {
      if (generation !== this.generation) throw new Error('ChatGPT navigated during the stylesheet update; application was not confirmed.');
    };
    const frame = await this.frame();
    requireDocument();
    if (css) this.beforeWrite();
    if (!this.sheet && css) {
      const result = await this.cdp.call('CSS.createStyleSheet', { frameId: frame.id, force: true });
      requireDocument();
      this.sheet = result.styleSheetId;
    }
    if (this.sheet) {
      await this.requireOwner();
      requireDocument();
      if (css) this.beforeWrite();
      await this.cdp.call('CSS.setStyleSheetText', { styleSheetId: this.sheet, text: css });
      requireDocument();
      const result = await this.cdp.call('CSS.getStyleSheetText', { styleSheetId: this.sheet });
      requireDocument();
      if (result.text !== css) throw new Error('ChatGPT did not confirm the requested stylesheet contents.');
    }
    const voice = await this.voice();
    requireDocument();
    this.needsUpdate = false;
    return voice;
  }

  async dispose() {
    try {
      // Keep the generation observer through cleanup: navigation during its
      // readback must not acknowledge removal from a replacement document.
      if (this.sheet) await this.set('');
    } finally { this.cdp.off('Page.frameNavigated', this.onNavigation); }
  }
}
