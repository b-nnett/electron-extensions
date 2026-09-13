import { EventEmitter } from 'node:events';

// Both sides use this fixed validator. Request JSON is never executable in the
// main process; source text can only be a renderer CDP command parameter.
export function validateInspectorRendererCommand(method, params, state) {
  const keys = {
    'Page.enable': [], 'Page.getFrameTree': [], 'DOM.enable': [], 'CSS.enable': [],
    'CSS.createStyleSheet': ['frameId', 'force'], 'CSS.setStyleSheetText': ['styleSheetId', 'text'],
    'CSS.getStyleSheetText': ['styleSheetId'], 'Runtime.enable': [],
    'Runtime.evaluate': ['expression', 'uniqueContextId', 'returnByValue', 'awaitPromise', 'timeout', 'allowUnsafeEvalBlockedByCSP'],
    'Runtime.compileScript': ['expression', 'sourceURL', 'persistScript', 'executionContextId'],
    'Page.createIsolatedWorld': ['frameId', 'worldName', 'grantUniveralAccess']
  };
  if (state.ownedFixture === true) keys['Page.reload'] = [];
  if (!Object.hasOwn(keys, method) || !params || typeof params !== 'object' || Array.isArray(params) ||
      Object.keys(params).some(key => !keys[method].includes(key)) || JSON.stringify(params).length > 768 * 1024) {
    throw new Error('Renderer command is outside the fixed inspector adapter.');
  }
  const label = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
  if (method === 'Runtime.evaluate' && (typeof params.expression !== 'string' || params.expression.length > 512 * 1024 ||
      !label(params.uniqueContextId) || !state.uniqueContexts.has(params.uniqueContextId) || params.returnByValue !== true ||
      params.awaitPromise !== true || params.timeout !== 10000 || params.allowUnsafeEvalBlockedByCSP !== false)) throw new Error('Unowned or privileged renderer evaluation refused.');
  if (method === 'Runtime.compileScript' && (typeof params.expression !== 'string' || params.expression.length > 512 * 1024 ||
      params.sourceURL !== '' || params.persistScript !== false || !state.contexts.has(params.executionContextId))) throw new Error('Unowned renderer compilation refused.');
  if (method === 'Page.createIsolatedWorld' && (params.frameId !== state.frameID ||
      !/^ea-owned-extension-[0-9a-f-]{36}$/.test(params.worldName ?? '') || params.grantUniveralAccess !== false)) throw new Error('Unowned or privileged renderer world refused.');
  if (method === 'CSS.createStyleSheet' && (params.frameId !== state.frameID || params.force !== true)) throw new Error('Unowned stylesheet frame refused.');
  if (['CSS.setStyleSheetText', 'CSS.getStyleSheetText'].includes(method) && !state.sheets.has(params.styleSheetId)) throw new Error('Unowned stylesheet refused.');
  if (method === 'CSS.setStyleSheetText' && (typeof params.text !== 'string' || new TextEncoder().encode(params.text).length > 64 * 1024)) throw new Error('Stylesheet exceeds 64 KiB.');
}

function fixedProfile(mode) {
  if (mode === 'claude') return { executable: '/Applications/Claude.app/Contents/MacOS/Claude', url: 'https://claude.ai/new' };
  if (mode === 'owned-fixture') return { executable: '/Applications/Style Lab.app/Contents/MacOS/Style Lab',
    url: 'file:///Applications/Style%20Lab.app/Contents/Resources/app.asar/index.html' };
  throw new Error('Unknown fixed inspector adapter.');
}

function discoverMainRenderer(mode, profileFor) {
  const profile = profileFor(mode);
  if (process.execPath !== profile.executable) throw new Error('The main process executable does not match the fixed adapter.');
  const electron = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
  const matches = electron.webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'window' && w.getURL() === profile.url);
  if (matches.length > 1) throw new Error('Multiple matching app windows are open. Close extra windows before attaching.');
  return matches.length ? { ready: true, id: matches[0].id, debuggerAttached: matches[0].debugger.isAttached() } : { ready: false };
}

function createMainBridge(mode, expectedID, profileFor, validate) {
  const profile = profileFor(mode);
  if (process.execPath !== profile.executable || !Number.isSafeInteger(expectedID) || expectedID <= 0) throw new Error('Invalid fixed main-process identity.');
  const electron = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
  const w = electron.webContents.fromId(expectedID);
  const state = { frameID: null, contexts: new Set(), uniqueContexts: new Set(), sheets: new Set(), ownedFixture: mode === 'owned-fixture' };
  const worlds = new Set(), contextMap = new Map();
  let owned = false, closed = false, failure = null, touched = Date.now(), bytes = 0, sequence = 0;
  let events = [], timer;
  const validateTarget = () => {
    if (process.execPath !== profile.executable || !w || w.isDestroyed() || w.getType() !== 'window' || w.getURL() !== profile.url) throw new Error('The fixed renderer document changed or closed.');
    const matches = electron.webContents.getAllWebContents().filter(item => !item.isDestroyed() && item.getType() === 'window' && item.getURL() === profile.url);
    if (matches.length !== 1 || matches[0].id !== expectedID) throw new Error('The fixed renderer became ambiguous or changed identity.');
  };
  validateTarget();
  if (w.debugger.isAttached()) throw new Error('This renderer already has a debugger. Close its DevTools before attaching extensions.');
  const clearContexts = () => { state.contexts.clear(); state.uniqueContexts.clear(); contextMap.clear(); };
  const push = (method, params) => {
    if (failure) return;
    const entry = { sequence: ++sequence, method, params }, size = Buffer.byteLength(JSON.stringify(entry));
    if (size > 256 * 1024 || events.length >= 256 || bytes + size > 512 * 1024) {
      failure = 'The renderer event queue exceeded its bounded capacity.'; events = []; bytes = 0; return;
    }
    events.push(entry); bytes += size;
  };
  const onMessage = (_event, method, params, sessionId) => { try {
    if (closed || !owned || sessionId) return;
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      if (!worlds.has(context?.name) || context.auxData?.frameId !== state.frameID || typeof context.uniqueId !== 'string') return;
      state.contexts.add(context.id); state.uniqueContexts.add(context.uniqueId); contextMap.set(context.id, context.uniqueId);
    } else if (method === 'Runtime.executionContextDestroyed') {
      if (!state.contexts.has(params.executionContextId)) return;
      const unique = contextMap.get(params.executionContextId);
      if (params.executionContextUniqueId && params.executionContextUniqueId !== unique) return;
      state.contexts.delete(params.executionContextId); state.uniqueContexts.delete(unique); contextMap.delete(params.executionContextId);
    } else if (method === 'Runtime.executionContextsCleared') clearContexts();
    else if (method === 'Runtime.consoleAPICalled') { if (!state.contexts.has(params.executionContextId)) return; }
    else if (method === 'Runtime.exceptionThrown') { if (!state.contexts.has(params.exceptionDetails?.executionContextId)) return; }
    else if (method === 'Page.frameNavigated') {
      if (!params.frame || params.frame.parentId) return;
      state.frameID = params.frame.id; state.sheets.clear(); clearContexts();
    } else if (method !== 'Page.loadEventFired') return;
    push(method, params);
  } catch { failure = 'Invalid renderer protocol event.'; events = []; bytes = 0; } };
  const onDetach = () => { owned = false; push('disconnected', {}); };
  const drain = () => { const result = events; events = []; bytes = 0; return result; };
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(timer);
    w.debugger.removeListener('message', onMessage); w.debugger.removeListener('detach', onDetach);
    // A detach event revokes ownership, so a subsequently attached debugger is
    // never displaced by our cleanup or abandoned-session timer.
    if (owned && !w.isDestroyed() && w.debugger.isAttached()) w.debugger.detach();
    owned = false; clearContexts(); state.sheets.clear();
  };
  w.debugger.on('message', onMessage); w.debugger.on('detach', onDetach);
  try { w.debugger.attach('1.3'); owned = true; }
  catch (error) { close(); throw error; }
  timer = setInterval(() => {
    if (Date.now() - touched > 30000) { try { close(); } catch { failure = 'Abandoned renderer debugger cleanup could not be confirmed.'; } }
  }, 1000); timer.unref();
  return { async run(request) {
    if (!request || typeof request !== 'object' || !['call', 'poll', 'close'].includes(request.operation)) throw new Error('Invalid bridge operation.');
    if (request.operation === 'close') { close(); return { result: { detached: true }, events: drain() }; }
    if (closed || !owned || !w.debugger.isAttached()) throw new Error('The owned renderer debugger detached.');
    if (failure) throw new Error(failure);
    validateTarget(); touched = Date.now();
    if (request.operation === 'poll') return { result: {}, events: drain() };
    validate(request.method, request.params, state);
    if (request.method === 'Page.createIsolatedWorld') {
      if (!worlds.has(request.params.worldName) && worlds.size >= 64) throw new Error('Too many isolated renderer worlds.');
      worlds.add(request.params.worldName);
    }
    const result = await w.debugger.sendCommand(request.method, request.params);
    validateTarget();
    if (request.method === 'Page.getFrameTree') {
      if (result.frameTree?.frame?.url !== profile.url) throw new Error('Unexpected renderer frame route.');
      state.frameID = result.frameTree.frame.id;
    }
    if (request.method === 'CSS.createStyleSheet') {
      if (typeof result.styleSheetId !== 'string' || !result.styleSheetId) throw new Error('Missing owned stylesheet identity.');
      state.sheets.add(result.styleSheetId);
    }
    if (failure || Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('Renderer response exceeds the bounded adapter.');
    return { result, events: drain() };
  } };
}

// These declarations are assembled only from this module's fixed functions.
// Authored source and request fields are separate Runtime.callFunctionOn JSON
// arguments and never interpolated into a main-process function declaration.
export const MAIN_RENDERER_DISCOVERY = `function(mode) { return (${discoverMainRenderer.toString()})(mode, ${fixedProfile.toString()}); }`;
export const MAIN_RENDERER_BOOTSTRAP = `function(mode,id) { return (${createMainBridge.toString()})(mode,id,${fixedProfile.toString()},${validateInspectorRendererCommand.toString()}); }`;
export const MAIN_RENDERER_DISPATCH = 'function(request) { return this.run(request); }';

export class MainInspectorRenderer extends EventEmitter {
  constructor({ inspector, requireOwner, ownedFixture = false }) {
    super();
    if (!inspector?.call || typeof requireOwner !== 'function' || typeof ownedFixture !== 'boolean') throw new Error('A verified inspector transport is required.');
    this.inspector = inspector; this.requireOwner = requireOwner;
    this.mode = ownedFixture ? 'owned-fixture' : 'claude'; this.queue = Promise.resolve(); this.sequence = 0;
    this.onDisconnect = () => this.emit('disconnected');
    inspector.on('disconnected', this.onDisconnect);
  }
  async prepare() {
    await this.requireOwner();
    const response = await this.inspector.call('Runtime.evaluate', { expression: 'globalThis', returnByValue: false });
    await this.requireOwner();
    if (response.exceptionDetails || !response.result?.objectId) throw new Error('The fixed main-process context is unavailable.');
    this.globalID = response.result.objectId;
  }
  async fixedCall(objectId, functionDeclaration, values, returnByValue = true) {
    await this.requireOwner();
    const response = await this.inspector.call('Runtime.callFunctionOn', { objectId, functionDeclaration,
      arguments: values.map(value => ({ value })), returnByValue, awaitPromise: true });
    await this.requireOwner();
    if (response.exceptionDetails) throw new Error(String(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Fixed inspector adapter failed.').split('\n')[0].slice(0, 500));
    return response.result;
  }
  async discover() {
    return (await this.fixedCall(this.globalID, MAIN_RENDERER_DISCOVERY, [this.mode])).value;
  }
  async attach(id) {
    if (this.bridgeID || !Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid renderer attachment.');
    const result = await this.fixedCall(this.globalID, MAIN_RENDERER_BOOTSTRAP, [this.mode, id], false);
    if (!result?.objectId) throw new Error('The fixed renderer bridge was not created.');
    this.bridgeID = result.objectId;
    this.timer = setInterval(() => {
      if (this.polling || this.closed) return;
      this.polling = true;
      this.dispatch({ operation: 'poll' }).catch(error => { this.emit('failure', error); }).finally(() => { this.polling = false; });
    }, 250);
    this.timer.unref();
  }
  dispatch(request) {
    const operation = this.queue.then(async () => {
      if (!this.bridgeID || (this.closed && request.operation !== 'close')) throw new Error('The inspector renderer is closed.');
      if (Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024) throw new Error('The renderer request exceeds 1 MiB.');
      const envelope = (await this.fixedCall(this.bridgeID, MAIN_RENDERER_DISPATCH, [request])).value;
      if (!envelope || !Array.isArray(envelope.events) || envelope.events.length > 256 || Buffer.byteLength(JSON.stringify(envelope)) > 2 * 1024 * 1024) throw new Error('Invalid renderer response envelope.');
      for (const event of envelope.events) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= this.sequence) throw new Error('Renderer event ordering changed.');
        this.sequence = event.sequence; this.emit(event.method, event.params);
      }
      return envelope.result;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  call(method, params = {}) { return this.dispatch({ operation: 'call', method, params }); }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    try { if (this.bridgeID) await this.dispatch({ operation: 'close' }); }
    finally { this.inspector.off('disconnected', this.onDisconnect); }
  }
}
