import { selectRendererExtensions } from './dock-library.mjs';
import { readBoundedJSON } from './catalog-stylesheet.mjs';

export const CLAUDE_APP_KEY = 'com.anthropic.claudefordesktop';
export const CLAUDE_BUNDLE = '/Applications/Claude.app';
export const CLAUDE_EXECUTABLE = `${CLAUDE_BUNDLE}/Contents/MacOS/Claude`;
export const CLAUDE_PAGE = 'https://claude.ai/new';
export const CLAUDE_SETUP = 'In Claude, choose Help → Troubleshooting → Enable Developer Mode, then Developer → Enable Main Process Debugger. The debugger needs enabling again after each app launch.';
export const selectClaudeExtensions = library => selectRendererExtensions(library, { appKey: CLAUDE_APP_KEY, name: 'Claude' });
export const readClaudeExtensions = async file => selectClaudeExtensions(await readBoundedJSON(file, 64 * 1024 * 1024));

export function parseClaudeRegistry(value) {
  if (!Array.isArray(value) || value.length > 16 || value.some(item => !Number.isInteger(item?.pid) || item.pid <= 0 ||
      item.bundleIdentifier !== CLAUDE_APP_KEY || item.bundlePath !== CLAUDE_BUNDLE)) throw new Error('Claude has an unidentified or differently installed running instance.');
  if (value.length > 1) throw new Error('Multiple Claude instances are running. Close extra instances before using extensions.');
  return value[0] ?? null;
}

// Only an already-owned, fixed-route renderer transport may be supplied. This
// CSS adapter has no vendor control requirement and keeps navigation observed
// through cleanup. It never evaluates source or discovers another target.
export class InspectorRendererStylesheet {
  constructor(page, requirePage, beforeWrite = () => {}) {
    this.page = page; this.requirePage = requirePage; this.beforeWrite = beforeWrite; this.sheet = null; this.generation = 0; this.needsUpdate = true;
    this.onNavigation = ({ frame }) => {
      if (!frame?.parentId) { this.generation++; this.sheet = null; this.needsUpdate = true; }
    };
    page.on('Page.frameNavigated', this.onNavigation);
  }
  async init() {
    for (const method of ['Page.enable', 'DOM.enable', 'CSS.enable']) await this.page.call(method);
    await this.frame();
  }
  async frame() {
    const { frameTree } = await this.page.call('Page.getFrameTree');
    const frame = frameTree?.frame;
    if (!frame?.id || !this.requirePage(frame.url)) throw new Error('The renderer is outside the fixed app document.');
    return frame;
  }
  async set(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024) throw new Error('The stylesheet exceeds 64 KiB.');
    const generation = this.generation;
    const current = () => { if (generation !== this.generation) throw new Error('The renderer navigated during its stylesheet update.'); };
    const frame = await this.frame(); current();
    if (text) this.beforeWrite();
    if (!this.sheet && text) {
      const result = await this.page.call('CSS.createStyleSheet', { frameId: frame.id, force: true }); current();
      if (typeof result.styleSheetId !== 'string' || !result.styleSheetId) throw new Error('The renderer did not create a stylesheet.');
      this.sheet = result.styleSheetId;
    }
    if (this.sheet) {
      if (text) this.beforeWrite();
      await this.page.call('CSS.setStyleSheetText', { styleSheetId: this.sheet, text }); current();
      const result = await this.page.call('CSS.getStyleSheetText', { styleSheetId: this.sheet }); current();
      if (result.text !== text) throw new Error('The renderer did not confirm the stylesheet contents.');
    }
    this.needsUpdate = false;
    return { generation, stylesheetReadbackVerified: true };
  }
  async dispose() {
    try { if (this.sheet) await this.set(''); }
    finally { this.page.off('Page.frameNavigated', this.onNavigation); }
  }
}
