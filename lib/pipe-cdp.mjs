import { EventEmitter } from 'node:events';

const TIMEOUT_MS = 8000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const SURFACE_TYPES = new Set(['page', 'webview']);
const BROWSER_METHODS = new Set([
  'Browser.getVersion', 'Target.getTargets', 'Target.attachToTarget', 'Target.detachFromTarget'
]);
const PAGE_METHODS = new Set([
  'Page.enable', 'Page.getFrameTree', 'Page.captureScreenshot', 'Page.getLayoutMetrics',
  'DOM.enable', 'DOM.getDocument', 'DOM.querySelectorAll', 'DOM.getBoxModel', 'DOM.describeNode',
  'CSS.enable', 'CSS.getComputedStyleForNode', 'CSS.createStyleSheet', 'CSS.setStyleSheetText', 'CSS.getStyleSheetText'
]);
const RENDERER_SCRIPT_METHODS = new Set(['Runtime.enable', 'Runtime.evaluate', 'Runtime.compileScript', 'Page.createIsolatedWorld']);
const RENDERER_SCRIPT_EVENTS = new Set(['Runtime.consoleAPICalled', 'Runtime.exceptionThrown',
  'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared']);

// Takes ownership of the two CDP streams, not the process. The caller establishes
// app ownership and manages process lifetime. Only explicitly discovered page/webview
// targets may be attached. Renderer JavaScript requires an explicit grant for an
// attached page session; the caller validates the exact app and document first.
export class PipeCDP extends EventEmitter {
  #readable;
  #writable;
  #buffer = Buffer.alloc(0);
  #pending = new Map();
  #surfaces = new Set();
  #sessions = new Set();
  #scriptSessions = new Set();
  #nextId = 0;
  #closed = false;
  #allowOwnedFixtureReload = false;
  #decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(readable, writable, { allowOwnedFixtureReload = false } = {}) {
    super();
    if (!readable?.on || !readable?.destroy || !writable?.on || !writable?.write || !writable?.destroy) {
      throw new TypeError('Supply readable and writable CDP pipe streams.');
    }
    if (typeof allowOwnedFixtureReload !== 'boolean') throw new TypeError('Owned-fixture reload capability must be a boolean.');
    this.#allowOwnedFixtureReload = allowOwnedFixtureReload;
    this.#readable = readable;
    this.#writable = writable;
    readable.on('data', this.#onData);
    readable.on('end', this.#onEnd);
    readable.on('close', this.#onEnd);
    readable.on('error', this.#onError);
    writable.on('error', this.#onError);
    writable.on('close', this.#onEnd);
    writable.on('finish', this.#onEnd);
  }

  #onError = error => this.#shutdown(error instanceof Error ? error : new Error('CDP pipe failed.'));
  #onEnd = () => this.#shutdown(new Error('CDP pipe closed.'));
  #onData = chunk => {
    if (this.#closed) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this.#buffer.length + bytes.length > MAX_FRAME_BYTES) throw new Error('CDP pipe buffer exceeded 4 MiB.');
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      let boundary;
      while ((boundary = this.#buffer.indexOf(0)) !== -1) {
        const frame = this.#buffer.subarray(0, boundary);
        this.#buffer = this.#buffer.subarray(boundary + 1);
        if (!frame.length) throw new Error('CDP pipe received an empty frame.');
        const message = JSON.parse(this.#decoder.decode(frame));
        this.#dispatch(message);
        if (this.#closed) return;
      }
    } catch (error) { this.#shutdown(error); }
  };

  #dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid CDP message.');
    if (Object.hasOwn(message, 'id')) {
      const pending = this.#pending.get(message.id);
      if (!pending) return; // Includes late responses to timed-out calls.
      if (message.sessionId !== pending.sessionId) throw new Error('CDP response session did not match its request.');
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message ?? 'protocol error'}`));
        return;
      }
      const result = message.result ?? {};
      try {
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid CDP result.');
        if (pending.method === 'Target.getTargets') {
          if (!Array.isArray(result.targetInfos)) throw new Error('Target listing returned no target array.');
          this.#surfaces = new Set(result.targetInfos.filter(target => SURFACE_TYPES.has(target?.type)).map(target => target.targetId));
        } else if (pending.method === 'Target.attachToTarget') {
          if (typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('Page attachment returned no session ID.');
          this.#sessions.add(result.sessionId);
        } else if (pending.method === 'Target.detachFromTarget') {
          this.#detachSession(pending.params.sessionId);
        }
      } catch (error) { pending.reject(error); throw error; }
      pending.resolve(result);
    } else if (typeof message.method === 'string') {
      if (message.method === 'Target.detachedFromTarget') this.#detachSession(message.params?.sessionId);
      const scriptEvent = message.method.startsWith('Runtime.');
      if (scriptEvent && (!RENDERER_SCRIPT_EVENTS.has(message.method) || !this.#scriptSessions.has(message.sessionId))) return;
      this.emit('event', message);
      // Avoid special EventEmitter names such as "error" from remote input.
      if (scriptEvent || /^(Page|DOM|CSS|Target)\.[A-Za-z]+$/.test(message.method)) {
        this.emit(message.method, message.params ?? {}, message.sessionId);
      }
    } else throw new Error('CDP message lacked an ID or event method.');
  }

  #detachSession(sessionId) {
    if (typeof sessionId !== 'string') return;
    this.#sessions.delete(sessionId);
    this.#scriptSessions.delete(sessionId);
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new Error('CDP page session detached.'));
    }
  }

  enableRendererJavaScript(sessionId) {
    if (this.#closed || typeof sessionId !== 'string' || !this.#sessions.has(sessionId)) {
      throw new Error('Renderer JavaScript requires this client’s attached page session.');
    }
    this.#scriptSessions.add(sessionId);
  }

  call(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error('CDP pipe is closed.'));
    if (!params || typeof params !== 'object' || Array.isArray(params)) return Promise.reject(new TypeError('CDP params must be an object.'));
    params = { ...params };
    if (BROWSER_METHODS.has(method)) {
      if (sessionId !== undefined) return Promise.reject(new Error('Browser metadata commands must not use a page session.'));
      if (method === 'Target.attachToTarget' &&
          (!this.#surfaces.has(params.targetId) || params.flatten !== true)) {
        return Promise.reject(new Error('Attach only a page or webview discovered by Target.getTargets, using flatten: true.'));
      }
      if (method === 'Target.detachFromTarget' && !this.#sessions.has(params.sessionId)) {
        return Promise.reject(new Error('Detach only this client’s attached page session.'));
      }
    } else if (RENDERER_SCRIPT_METHODS.has(method) || (method === 'Page.reload' && this.#allowOwnedFixtureReload)) {
      if (!this.#scriptSessions.has(sessionId) || !this.#sessions.has(sessionId)) {
        return Promise.reject(new Error('Renderer JavaScript is not allowed for this page session.'));
      }
      if (method === 'Runtime.evaluate' && params.allowUnsafeEvalBlockedByCSP !== false) {
        return Promise.reject(new Error('Renderer evaluation cannot bypass CSP.'));
      }
      if (method === 'Page.createIsolatedWorld' && (params.grantUniveralAccess !== false || params.grantUniversalAccess)) {
        return Promise.reject(new Error('Renderer worlds cannot receive universal access.'));
      }
    } else if (PAGE_METHODS.has(method)) {
      if (typeof sessionId !== 'string' || !this.#sessions.has(sessionId)) {
        return Promise.reject(new Error('Page commands require this client’s attached page session ID.'));
      }
    } else return Promise.reject(new Error(`CDP method is not allowed: ${String(method)}`));

    const id = ++this.#nextId;
    let payload;
    try { payload = Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', 'utf8'); }
    catch (error) { return Promise.reject(error); }
    if (payload.length > MAX_FRAME_BYTES) return Promise.reject(new Error('CDP request exceeded 4 MiB.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${TIMEOUT_MS} ms.`));
      }, TIMEOUT_MS);
      this.#pending.set(id, { method, params, sessionId, resolve, reject, timer });
      try {
        this.#writable.write(payload, error => { if (error) this.#shutdown(error); });
      } catch (error) { this.#shutdown(error); }
    });
  }

  #shutdown(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#readable.removeListener('data', this.#onData);
    this.#buffer = Buffer.alloc(0);
    this.#surfaces.clear();
    this.#sessions.clear();
    this.#scriptSessions.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    // Keep end/error handlers through stream destruction to consume late errors.
    this.#readable.destroy();
    if (this.#writable !== this.#readable) this.#writable.destroy();
    this.emit('disconnected', error);
  }

  close() { this.#shutdown(new Error('CDP pipe connection closed.')); }
}
