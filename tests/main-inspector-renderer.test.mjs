import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { MainInspectorRenderer, MAIN_RENDERER_BOOTSTRAP, MAIN_RENDERER_DISCOVERY, MAIN_RENDERER_DISPATCH, validateInspectorRendererCommand } from '../lib/main-inspector-renderer.mjs';
import { InspectorRendererStylesheet, CLAUDE_PAGE } from '../lib/claude-extensions.mjs';
import { RendererScriptController } from '../lib/renderer-script-controller.mjs';

// Separate synthetic main/renderer VMs prove where source is executed. No app,
// filesystem, network, preferences, or live debugger is involved in these tests.
class FakeInspector extends EventEmitter {
  constructor() {
    super(); this.calls = []; this.effects = []; this.detaches = 0; this.owned = false; this.sheets = new Map();
    const d = this.debugger = new EventEmitter();
    d.isAttached = () => this.owned;
    d.attach = () => { assert.equal(this.owned, false); this.owned = true; };
    d.detach = () => { this.owned = false; this.detaches++; d.emit('detach'); };
    d.sendCommand = async (method, params) => {
      if (['Page.enable', 'DOM.enable', 'CSS.enable', 'Runtime.enable'].includes(method)) return {};
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: this.url } } };
      if (method === 'CSS.createStyleSheet') { this.sheets.set('sheet', ''); return { styleSheetId: 'sheet' }; }
      if (method === 'CSS.setStyleSheetText') { this.sheets.set(params.styleSheetId, params.text); return {}; }
      if (method === 'CSS.getStyleSheetText') return { text: this.sheets.get(params.styleSheetId) };
      if (method === 'Page.createIsolatedWorld') {
        this.renderer = vm.createContext({ TextEncoder, AbortController, setTimeout, clearTimeout, effects: this.effects,
          console: { debug: (...args) => this.event('Runtime.consoleAPICalled', { executionContextId: 7, type: 'debug', args: args.map(value => ({ value })) }) } });
        this.event('Runtime.executionContextCreated', { context: { id: 7, uniqueId: 'unique-world', name: params.worldName, auxData: { frameId: 'frame' } } });
        return { executionContextId: 7 };
      }
      if (method === 'Runtime.compileScript') { new vm.Script(params.expression); return {}; }
      if (method === 'Runtime.evaluate') {
        assert.equal(params.uniqueContextId, 'unique-world');
        const value = await vm.runInContext(params.expression, this.renderer);
        return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
      }
      throw new Error(`Unexpected renderer method: ${method}`);
    };
    this.url = CLAUDE_PAGE;
    this.window = { id: 1, getURL: () => this.url, isDestroyed: () => false, getType: () => 'window', debugger: d };
    this.windows = [this.window];
    const electron = { webContents: { getAllWebContents: () => this.windows, fromId: id => id === 1 ? this.window : undefined } };
    this.main = vm.createContext({ Buffer, TextEncoder, setInterval, clearInterval, mainSentinel: 'unchanged',
      process: { execPath: '/Applications/Claude.app/Contents/MacOS/Claude', getBuiltinModule: name => {
        assert.equal(name, 'module'); return { createRequire: () => name => { assert.equal(name, 'electron'); return electron; } };
      } } });
    this.objects = new Map([['global', this.main]]);
  }
  event(method, params) { this.debugger.emit('message', {}, method, params); }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'Runtime.evaluate') { assert.equal(params.expression, 'globalThis'); return { result: { objectId: 'global' } }; }
    assert.equal(method, 'Runtime.callFunctionOn');
    assert.ok([MAIN_RENDERER_BOOTSTRAP, MAIN_RENDERER_DISCOVERY, MAIN_RENDERER_DISPATCH].includes(params.functionDeclaration));
    try {
      const fn = vm.runInContext(`(${params.functionDeclaration})`, this.main);
      const result = await fn.apply(this.objects.get(params.objectId), params.arguments.map(item => item.value));
      if (params.returnByValue) return { result: { value: JSON.parse(JSON.stringify(result)) } };
      this.objects.set('bridge', result); return { result: { objectId: 'bridge' } };
    } catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
  }
}
async function setup(t) {
  const inspector = new FakeInspector(); let allowed = true, ownerChecks = 0;
  const page = new MainInspectorRenderer({ inspector, requireOwner: async () => { ownerChecks++; if (!allowed) throw new Error('owner changed'); } });
  await page.prepare(); await page.attach((await page.discover()).id);
  const styles = new InspectorRendererStylesheet(page, url => url === CLAUDE_PAGE); await styles.init();
  t.after(() => page.close().catch(() => {}));
  return { inspector, page, styles, revoke: () => { allowed = false; }, checks: () => ownerChecks };
}
const selection = [{ extensionID: '01234567-89ab-cdef-0123-456789abcdef', revision: 'revision1', files: [{ fileName: 'main.js',
  text: 'effects.push("renderer-only"); console.log("attributed"); ea.onDispose(() => effects.push("removed"));' }] }];
test('fixed main bridge executes imported source only in its owned renderer and cleans CSS/scripts', async t => {
  const { inspector, page, styles, checks } = await setup(t);
  const controller = new RendererScriptController({ cdp: page, appName: 'Synthetic Claude', assertPage: async () => (await styles.frame()).id });
  t.after(() => controller.dispose().catch(() => {})); await controller.init();
  await styles.set('button { color: green }'); await controller.sync(selection); await controller.sync(selection);
  assert.deepEqual(inspector.effects, ['renderer-only']); assert.equal(inspector.main.mainSentinel, 'unchanged');
  assert.equal(controller.uniqueContext, 'unique-world');
  assert.ok(controller.logs().some(event => event.message === 'attributed' && event.fileName === 'main.js'));
  assert.ok(inspector.calls.every(call => !call.params.functionDeclaration?.includes('renderer-only')));
  assert.ok(inspector.calls.some(call => JSON.stringify(call.params.arguments ?? []).includes('renderer-only')));
  assert.ok(checks() > inspector.calls.length);
  await controller.sync([]); assert.deepEqual(inspector.effects, ['renderer-only', 'removed']);
  await styles.dispose(); assert.equal(inspector.sheets.get('sheet'), '');
  await controller.dispose(); await page.close(); assert.equal(inspector.detaches, 1);
});
test('existing or replacement DevTools is never detached by the adapter', async t => {
  const inspector = new FakeInspector(); inspector.owned = true;
  const refused = new MainInspectorRenderer({ inspector, requireOwner: async () => {} }); t.after(() => refused.close());
  await refused.prepare(); assert.equal((await refused.discover()).debuggerAttached, true);
  await assert.rejects(refused.attach(1), /already has a debugger/); assert.equal(inspector.detaches, 0);
  const { inspector: active, page } = await setup(t);
  active.owned = false; active.event('Runtime.executionContextsCleared', {}); active.debugger.emit('detach'); active.owned = true;
  await assert.rejects(page.call('Page.getFrameTree'), /detached/);
  await page.close(); assert.equal(active.detaches, 0, 'A replacement debugger is not ours');
});
test('route ambiguity and kernel ownership changes revoke commands', async t => {
  const { inspector, page, revoke } = await setup(t);
  inspector.windows.push({ ...inspector.window, id: 2 });
  await assert.rejects(page.call('Page.getFrameTree'), /ambiguous/); inspector.windows.pop();
  inspector.url = 'https://claude.ai/chat/private'; await assert.rejects(page.call('Page.getFrameTree'), /changed/);
  inspector.url = CLAUDE_PAGE; revoke(); const count = inspector.calls.length;
  await assert.rejects(page.call('Page.getFrameTree'), /owner changed/); assert.equal(inspector.calls.length, count);
  // Restore fake authority for deterministic debugger cleanup; no real identity involved.
  page.requireOwner = async () => {}; await page.close();
});
test('unrelated renderer console and sub-session events do not reach runtime logs', async t => {
  const { inspector, page } = await setup(t); const events = [];
  page.on('Runtime.consoleAPICalled', value => events.push(value));
  inspector.event('Runtime.consoleAPICalled', { executionContextId: 999, args: [{ value: 'private app console' }] });
  inspector.debugger.emit('message', {}, 'Page.loadEventFired', {}, 'foreign-session');
  await page.call('Page.getFrameTree'); assert.deepEqual(events, []);
});
test('privileged, main-process and unowned renderer operations are refused before sendCommand', () => {
  const state = { frameID: 'frame', contexts: new Set([1]), uniqueContexts: new Set(['unique']), sheets: new Set(['sheet']) };
  for (const method of ['Browser.close', 'Page.reload', 'Page.setBypassCSP', 'Runtime.callFunctionOn', 'Target.getTargets']) {
    assert.throws(() => validateInspectorRendererCommand(method, {}, state), /outside/);
  }
  const evaluate = { expression: '1', uniqueContextId: 'unique', returnByValue: true, awaitPromise: true, timeout: 10000, allowUnsafeEvalBlockedByCSP: false };
  assert.doesNotThrow(() => validateInspectorRendererCommand('Runtime.evaluate', evaluate, state));
  for (const update of [{ uniqueContextId: 'foreign' }, { allowUnsafeEvalBlockedByCSP: true }, { contextId: 1 }])
    assert.throws(() => validateInspectorRendererCommand('Runtime.evaluate', { ...evaluate, ...update }, state));
  assert.throws(() => validateInspectorRendererCommand('CSS.setStyleSheetText', { styleSheetId: 'foreign', text: '' }, state), /Unowned/);
  assert.throws(() => validateInspectorRendererCommand('CSS.setStyleSheetText', { styleSheetId: 'sheet', text: 'é'.repeat(32769) }, state), /64 KiB/);
  assert.throws(() => validateInspectorRendererCommand('Page.createIsolatedWorld', { frameId: 'frame', worldName: 'ea-owned-extension-01234567-89ab-cdef-0123-456789abcdef', grantUniveralAccess: true }, state), /privileged/);
});
