import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Used only behind a launched app's process, transport and page validators.
// Runs user-selected source in a renderer isolated world. No Node, main-process
// execution or CSP bypass is enabled. This is not a security sandbox for scripts.
export class RendererScriptController extends EventEmitter {
  constructor({ cdp, assertPage, appName }) {
    super();
    if (!cdp || typeof assertPage !== 'function' || typeof appName !== 'string' || !appName.trim()) throw new TypeError('A verified app page transport and ownership validator are required.');
    this.assertPage = assertPage;
    this.appName = appName;
    this.cdp = cdp;
    this.context = null;
    this.uniqueContext = null;
    this.worlds = new Map();
    this.desired = [];
    this.ids = new Set();
    this.attribution = new Set();
    this.sourceLabels = new Map();
    this.events = [];
    this.eventBytes = 0;
    this.sequence = 0;
    this.droppedLogEvents = 0;
    this.queue = Promise.resolve();
    this.reapplication = Promise.resolve();
    this.closed = false;
    this.marker = `ea-owned-extension-${randomUUID()}`;
    this.key = `__ea_owned_${randomUUID().replaceAll('-', '')}`;
    this.onContextCreated = ({ context }) => {
      if (context?.name === this.marker && typeof context.uniqueId === 'string' && context.uniqueId && typeof context.auxData?.frameId === 'string') {
        this.worlds.set(context.id, { uniqueId: context.uniqueId, frameId: context.auxData.frameId });
      }
    };
    this.onContextDestroyed = ({ executionContextId, executionContextUniqueId }) => {
      const world = this.worlds.get(executionContextId);
      if (executionContextUniqueId && world?.uniqueId !== executionContextUniqueId) return;
      this.worlds.delete(executionContextId);
      if (executionContextId === this.context) this.clearContext();
    };
    this.onContextsCleared = () => { this.worlds.clear(); this.clearContext(); };
    this.onConsole = event => {
      if (event.executionContextId !== this.context || event.type !== 'debug' || event.args?.[0]?.value !== this.marker) return;
      const value = event.args?.[1]?.value;
      if (typeof value !== 'string' || Buffer.byteLength(value) > 8192) return;
      try {
        const record = JSON.parse(value);
        if (!this.attribution.has(this.attributionKey(record)) ||
            !['log', 'info', 'warn', 'error'].includes(record.level) || typeof record.message !== 'string' ||
            Buffer.byteLength(record.message) > 4096 || !Number.isFinite(Date.parse(record.timestamp))) return;
        this.appendLog(record);
      } catch { /* Unrelated or malformed renderer output is never collected. */ }
    };
    this.onException = ({ exceptionDetails: details }) => {
      if (!details || details.executionContextId !== this.context) return;
      const urls = [details.url, ...(details.stackTrace?.callFrames ?? []).slice(0, 32).map(frame => frame.url)];
      const source = urls.map(url => this.sourceLabels.get(url)).find(value => value && this.attribution.has(this.attributionKey(value)));
      if (!source) return;
      const firstLine = String(details.exception?.description ?? details.text ?? 'Uncaught extension error.').split('\n')[0];
      let message = 'Unhandled: ';
      for (const character of firstLine) {
        if (Buffer.byteLength(message + character) > 4096) break;
        message += character;
      }
      this.appendLog({ ...source, level: 'error', message, timestamp: new Date().toISOString() });
    };
    this.onNavigation = ({ frame }) => {
      if (frame.parentId) return;
      if (this.context !== null) {
        for (const record of this.desired) this.appendLog({ extensionID: record.extensionID,
          fileName: record.files[0].fileName, revision: record.revision, level: 'info',
          message: 'Document ended. Its execution context was discarded; cleanup callbacks were not verified.', timestamp: new Date().toISOString() });
      }
      this.clearContext();
    };
    this.onLoad = () => {
      if (this.closed || !this.desired.length) return;
      this.reapplication = this.enqueue(() => this.apply(this.desired));
      this.reapplication.then(states => this.emit('reapplied', states), error => this.emit('failure', error));
    };
    this.onDisconnect = () => {
      this.worlds.clear(); this.clearContext();
      if (!this.closed && this.desired.length) this.emit('failure', new Error('selected app disconnected before extension cleanup could be verified.'));
    };
  }

  async init() {
    this.core = (await readFile(new URL('./fixture-extension-runtime.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
    this.cdp.on('Runtime.consoleAPICalled', this.onConsole);
    this.cdp.on('Runtime.exceptionThrown', this.onException);
    this.cdp.on('Runtime.executionContextCreated', this.onContextCreated);
    this.cdp.on('Runtime.executionContextDestroyed', this.onContextDestroyed);
    this.cdp.on('Runtime.executionContextsCleared', this.onContextsCleared);
    this.cdp.on('Page.frameNavigated', this.onNavigation);
    this.cdp.on('Page.loadEventFired', this.onLoad);
    this.cdp.on('disconnected', this.onDisconnect);
  }

  attributionKey(record) { return JSON.stringify([record.extensionID, record.revision, record.fileName]); }
  clearContext() {
    this.context = null; this.uniqueContext = null;
    this.ids.clear(); this.sourceLabels.clear();
  }
  setAttribution(records) {
    this.attribution = new Set(records.flatMap(record => record.files.map(file =>
      this.attributionKey({ extensionID: record.extensionID, revision: record.revision, fileName: file.fileName }))));
    for (const [url, source] of this.sourceLabels) if (!this.attribution.has(this.attributionKey(source))) this.sourceLabels.delete(url);
  }
  appendLog(record) {
    const event = { sequence: ++this.sequence, extensionID: record.extensionID, fileName: record.fileName,
      revision: record.revision, level: record.level, message: record.message, timestamp: record.timestamp };
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 128;
    this.events.push({ event, bytes }); this.eventBytes += bytes;
    while (this.events.length > 500 || this.eventBytes > 504 * 1024) {
      this.eventBytes -= this.events.shift().bytes; this.droppedLogEvents++;
    }
    this.emit('console', { ...event });
  }
  logs() { return this.events.map(({ event }) => ({ ...event })); }
  enqueue(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  validate(records) {
    if (!Array.isArray(records) || records.length > 64) throw new Error('selected app supports up to 64 enabled script extensions.');
    const ids = new Set();
    let bytes = 0;
    return records.map(record => {
      if (!record || typeof record.extensionID !== 'string' ||
          !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(record.extensionID) || ids.has(record.extensionID.toLowerCase()) ||
          typeof record.revision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.revision) ||
          !Array.isArray(record.files) || !record.files.length || record.files.length > 32) throw new Error('Invalid renderer script selection.');
      ids.add(record.extensionID.toLowerCase());
      const names = new Set();
      const files = record.files.map(file => {
        if (!file || typeof file.fileName !== 'string' || Buffer.byteLength(file.fileName) > 256 ||
            !file.fileName.toLowerCase().endsWith('.js') || /[\\:\u0000-\u001f\u007f-\u009f]/.test(file.fileName) ||
            file.fileName.split('/').some(part => !part || part === '.' || part === '..') || names.has(file.fileName) ||
            typeof file.text !== 'string') throw new Error('Invalid renderer JavaScript source.');
        names.add(file.fileName);
        bytes += Buffer.byteLength(file.text);
        if (bytes > 256 * 1024) throw new Error('Enabled selected app JavaScript exceeds 256 KiB.');
        return { fileName: file.fileName, text: file.text };
      });
      return { extensionID: record.extensionID, revision: record.revision, files };
    });
  }

  async assertOwnedPage() {
    const frameId = await this.assertPage();
    if (typeof frameId !== 'string' || !frameId) throw new Error('The selected app page has no verified main frame.');
    return frameId;
  }

  async ensureContext() {
    const frameId = await this.assertOwnedPage();
    if (this.context !== null) return;
    // A CSS-only session must not need script admission or execute bootstrap
    // code. Runtime events become necessary only for the first script world.
    if (!this.runtimeEnabled) {
      await this.cdp.call('Runtime.enable');
      this.runtimeEnabled = true;
    }
    const { executionContextId } = await this.cdp.call('Page.createIsolatedWorld', { frameId, worldName: this.marker, grantUniveralAccess: false });
    const world = this.worlds.get(executionContextId);
    if (!world || world.frameId !== frameId) throw new Error('The renderer did not expose a unique execution context for the selected app frame.');
    this.context = executionContextId;
    this.uniqueContext = world.uniqueId;
    const expression = `(() => { if (typeof globalThis.require !== 'undefined' || typeof globalThis.process !== 'undefined') throw new Error('The extension world unexpectedly exposes Node globals.'); ${this.core}\nObject.defineProperty(globalThis, ${JSON.stringify(this.key)}, {value: new FixtureExtensionRuntime({onLog: event => globalThis.console.debug(${JSON.stringify(this.marker)}, JSON.stringify(event))})}); })()`;
    await this.evaluate(expression, false);
  }

  async evaluate(expression, createContext = true) {
    if (createContext) await this.ensureContext();
    else await this.assertOwnedPage();
    const context = this.context;
    const uniqueContext = this.uniqueContext;
    if (context === null || !uniqueContext) throw new Error('The selected document changed before execution.');
    const response = await this.cdp.call('Runtime.evaluate', {
      expression, uniqueContextId: uniqueContext, returnByValue: true, awaitPromise: true,
      timeout: 10000, allowUnsafeEvalBlockedByCSP: false
    });
    if (this.context !== context || this.uniqueContext !== uniqueContext) throw new Error('The selected document changed during extension execution.');
    if (response.exceptionDetails) throw new Error((response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Extension evaluation failed.').slice(0, 4096));
    return response.result.value;
  }

  sync(records) {
    let selected;
    try { selected = this.validate(records); }
    catch (error) { return Promise.reject(error); }
    if (this.closed) return Promise.reject(new Error('The renderer extension session is closed.'));
    return this.enqueue(async () => {
      if (this.closed) throw new Error('The extension session closed before these scripts could run.');
      const previous = this.desired;
      this.desired = selected;
      this.setAttribution([...previous, ...selected]);
      const states = await this.apply(selected);
      this.setAttribution(selected);
      return states;
    });
  }

  async apply(selected) {
    if (this.closed) throw new Error('The extension session closed before these scripts could run.');
    if (!selected.length && this.context === null) return [];
    await this.ensureContext();
    if (this.closed) throw new Error('The extension session closed before these scripts could run.');
    const wanted = new Set(selected.map(record => record.extensionID));
    const removed = [...this.ids].filter(id => !wanted.has(id));
    const runtime = `globalThis[${JSON.stringify(this.key)}]`;
    const stopped = removed.length ? await this.evaluate(`Promise.all(${JSON.stringify(removed)}.map(id => ${runtime}.disable(id)))`) : [];
    const uncertain = stopped.filter(state => state && (state.phase !== 'disabled' || !state.cleanupComplete));
    if (uncertain.length) { const error = new Error('An extension could not be cleaned up. Reload selected app before replacing it.'); error.states = stopped; throw error; }
    for (const id of removed) this.ids.delete(id);
    await this.evaluate(`${runtime}.forgetDisabled()`);
    const definitionsKey = JSON.stringify(`${this.key}_definitions`);
    const definitions = selected.map(({ extensionID, revision }) => ({ extensionID, revision, files: [] }));
    await this.evaluate(`globalThis[${definitionsKey}] = ${JSON.stringify(definitions)}; undefined`);
    for (const [index, record] of selected.entries()) {
      for (const file of record.files) {
        if (this.closed) throw new Error('The extension session closed before these scripts could run.');
        await this.assertOwnedPage();
        const sourceURL = `ea-extension://${this.marker}/${record.extensionID}/${record.revision}/${encodeURIComponent(file.fileName)}`;
        this.sourceLabels.set(sourceURL, { extensionID: record.extensionID, revision: record.revision, fileName: file.fileName });
        const compiled = await this.cdp.call('Runtime.compileScript', {
          expression: `(async function(ea,console){"use strict";\n${file.text}\n})`,
          sourceURL: '', persistScript: false, executionContextId: this.context
        });
        // Syntax failures enter the same per-file lifecycle failure path. Other
        // extensions still load and any earlier files in this record clean up.
        const body = compiled.exceptionDetails ? 'throw new Error("JavaScript syntax error. Check this source file.");' : file.text;
        await this.evaluate(`globalThis[${definitionsKey}][${index}].files.push({fileName:${JSON.stringify(file.fileName)},execute:async function(ea,console){"use strict";\n${body}\n}}); undefined\n//# sourceURL=${sourceURL}`);
      }
    }
    for (const record of selected) this.ids.add(record.extensionID);
    if (this.closed) throw new Error('The extension session closed before these scripts could run.');
    const states = selected.length ? await this.evaluate(`Promise.all(globalThis[${definitionsKey}].map(definition => ${runtime}.enable(definition)))`) : [];
    await this.evaluate(`delete globalThis[${definitionsKey}]`);
    if (states.some(state => state.phase !== 'active')) {
      const error = new Error('One or more selected app scripts failed. Open the extension logs for details.'); error.states = states; throw error;
    }
    return states;
  }

  states() {
    return this.enqueue(async () => this.context === null ? [] : this.evaluate(
      `${JSON.stringify([...this.ids])}.map(id => globalThis[${JSON.stringify(this.key)}].state(id)).filter(Boolean)`));
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.cdp.off('Page.frameNavigated', this.onNavigation);
    this.cdp.off('Page.loadEventFired', this.onLoad);
    this.cdp.off('disconnected', this.onDisconnect);
    try {
      await this.enqueue(async () => {
        if (this.context === null) {
          if (this.desired.length) throw new Error('The document ended before JavaScript cleanup could be verified.');
          return;
        }
        const states = await this.evaluate(`globalThis[${JSON.stringify(this.key)}].dispose()`);
        if (states.some(state => !state.cleanupComplete)) throw new Error('JavaScript cleanup remains incomplete; the selected document must close.');
      });
    } finally {
      this.cdp.off('Runtime.consoleAPICalled', this.onConsole);
      this.cdp.off('Runtime.exceptionThrown', this.onException);
      this.cdp.off('Runtime.executionContextCreated', this.onContextCreated);
      this.cdp.off('Runtime.executionContextDestroyed', this.onContextDestroyed);
      this.cdp.off('Runtime.executionContextsCleared', this.onContextsCleared);
      this.desired = []; this.worlds.clear(); this.clearContext();
    }
  }
}
