import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { RendererScriptController } from '../lib/renderer-script-controller.mjs';

// Synthetic protocol + isolated JS globals only. No Electron, browser, DOM,
// application launch, filesystem write, or target debugger is involved.
class SyntheticPage extends EventEmitter {
  constructor() {
    super();
    this.frameID = 'owned-test-frame';
    this.world = null;
    this.calls = [];
    this.effects = [];
    this.beforeNextEvaluate = null;
  }

  createWorld(name, uniqueID = 'owned-test-world') {
    const globals = vm.createContext({ TextEncoder, AbortController, setTimeout, clearTimeout,
      effects: this.effects, console: { debug: (...args) => this.emit('Runtime.consoleAPICalled', {
        executionContextId: 1, type: 'debug', args: args.map(value => ({ value }))
      }) } });
    this.world = { id: 1, uniqueID, name, globals };
    this.emit('Runtime.executionContextCreated', { context: {
      id: 1, uniqueId: uniqueID, name, auxData: { frameId: this.frameID }
    } });
    return this.world;
  }

  async call(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'Runtime.enable') return {};
    if (method === 'Page.createIsolatedWorld') {
      assert.equal(params.frameId, this.frameID);
      assert.equal(params.grantUniveralAccess, false);
      if (!this.world) this.createWorld(params.worldName);
      return { executionContextId: this.world.id };
    }
    if (method === 'Runtime.compileScript') {
      assert.equal(params.executionContextId, this.world?.id);
      new vm.Script(params.expression);
      return {};
    }
    if (method === 'Runtime.evaluate') {
      const before = this.beforeNextEvaluate;
      this.beforeNextEvaluate = null;
      before?.();
      assert.equal(params.contextId, undefined, 'Evaluation must not use a reusable numeric context ID.');
      assert.equal(params.allowUnsafeEvalBlockedByCSP, false);
      if (params.uniqueContextId !== this.world?.uniqueID) throw new Error('The unique execution context ended.');
      const result = await vm.runInContext(params.expression, this.world.globals);
      return { result: { value: result === undefined ? undefined : JSON.parse(JSON.stringify(result)) } };
    }
    throw new Error(`Unexpected synthetic method: ${method}`);
  }
}

const selection = [{ extensionID: '01234567-89ab-cdef-0123-456789abcdef', revision: 'revision1', files: [{
  fileName: 'main.js', text: 'effects.push("initialized"); ea.onDispose(() => effects.push("disposed"));'
}] }];

async function setup(t) {
  const page = new SyntheticPage();
  const controller = new RendererScriptController({ cdp: page, appName: 'Synthetic page', assertPage: async () => page.frameID });
  await controller.init();
  t.after(() => controller.dispose().catch(() => {}));
  return { page, controller };
}

test('dispose prevents a queued synchronization from starting a script initializer', async t => {
  const { page, controller } = await setup(t);
  const pending = controller.sync(selection);
  const closing = controller.dispose();
  const [result] = await Promise.allSettled([pending, closing]);
  assert.equal(result.status, 'rejected');
  assert.deepEqual(page.effects, []);
  assert.equal(controller.closed, true);
  assert.equal(page.calls.filter(call => call.method === 'Runtime.evaluate').length, 0);
});

test('a reused numeric context cannot receive evaluation for a destroyed unique context', async t => {
  const { page, controller } = await setup(t);
  assert.equal((await controller.sync(selection))[0].phase, 'active');
  assert.deepEqual(page.effects, ['initialized']);
  const previous = page.world;
  page.beforeNextEvaluate = () => {
    page.emit('Runtime.executionContextDestroyed', {
      executionContextId: previous.id, executionContextUniqueId: previous.uniqueID
    });
    page.effects = [];
    page.createWorld('unrelated-world', 'different-unique-context');
  };
  await assert.rejects(controller.states(), /unique execution context ended/);
  assert.equal(controller.context, null);
  assert.equal(controller.uniqueContext, null);
  assert.deepEqual(page.effects, []);
  const final = page.calls.filter(call => call.method === 'Runtime.evaluate').at(-1);
  assert.equal(final.params.uniqueContextId, previous.uniqueID);
  assert.equal(final.params.contextId, undefined);
});

test('normal same-revision sync is idempotent and disposal still runs registered cleanup', async t => {
  const { page, controller } = await setup(t);
  await controller.sync(selection);
  await controller.sync(selection);
  assert.deepEqual(page.effects, ['initialized']);
  await controller.dispose();
  assert.deepEqual(page.effects, ['initialized', 'disposed']);
});

test('CSS-only controller lifecycle never requests Runtime admission or creates a JavaScript world', async t => {
  const { page, controller } = await setup(t);
  assert.deepEqual(page.calls, []);
  assert.deepEqual(await controller.sync([]), []);
  page.emit('Page.frameNavigated', { frame: { id: page.frameID } });
  page.emit('Page.loadEventFired', {});
  await controller.reapplication; await controller.queue;
  assert.deepEqual(await controller.states(), []);
  await controller.dispose();
  assert.deepEqual(page.calls, []);
});

test('first selected JavaScript enables Runtime lazily and keeps script admission failure explicit', async t => {
  const { page, controller } = await setup(t);
  await controller.sync([]);
  await controller.sync(selection);
  assert.equal(page.calls[0].method, 'Runtime.enable');
  await controller.sync(selection);
  assert.equal(page.calls.filter(call => call.method === 'Runtime.enable').length, 1);
  const refusing = new EventEmitter();
  refusing.call = async () => { throw new Error('Runtime admission refused'); };
  const other = new RendererScriptController({ cdp: refusing, appName: 'CSS-only', assertPage: async () => 'frame' });
  await other.init(); assert.deepEqual(await other.sync([]), []);
  await assert.rejects(other.sync(selection), /Runtime admission refused/);
  await assert.rejects(other.dispose(), /cleanup could be verified/);
});
