import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class CDP extends EventEmitter {
  constructor(url, timeout = 6000) {
    super();
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') {
      throw new Error('The fixture debugger must be on 127.0.0.1.');
    }
    this.timeout = timeout;
    this.nextID = 0;
    this.pending = new Map();
    this.socket = new WebSocket(url, { handshakeTimeout: timeout });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('error', error => this.failPending(error));
    this.socket.on('close', () => {
      this.failPending(new Error('The fixture debugger disconnected.'));
      this.emit('disconnected');
    });
    this.socket.on('message', bytes => {
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
      } else if (message.method) this.emit(message.method, message.params ?? {});
    });
  }

  async call(method, params = {}) {
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Debugger is closed.');
    const id = ++this.nextID;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.failPending(new Error('Debugger connection closed.'));
    this.socket.close();
  }
}

export class StylesheetController extends EventEmitter {
  constructor(cdp) {
    super();
    this.cdp = cdp;
    this.css = '';
    this.sheet = null;
    this.queue = Promise.resolve();
    this.reapplication = Promise.resolve();
    this.onNavigation = ({ frame }) => { if (!frame.parentId) this.sheet = null; };
    this.onLoad = () => {
      if (this.css) {
        this.reapplication = this.enqueue(() => this.write(this.css));
        this.reapplication.then(() => this.emit('reapplied'), error => this.emit('failure', error));
      } else this.reapplication = Promise.resolve();
    };
    cdp.on('Page.frameNavigated', this.onNavigation);
    cdp.on('Page.loadEventFired', this.onLoad);
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async init() {
    await this.cdp.call('Page.enable');
    await this.cdp.call('DOM.enable');
    await this.cdp.call('CSS.enable');
  }

  apply(css) {
    if (typeof css !== 'string' || Buffer.byteLength(css) > 65536) {
      throw new Error('Use a stylesheet smaller than 64 KB.');
    }
    return this.enqueue(async () => {
      await this.write(css);
      this.css = css;
      return this.inspectButton();
    });
  }

  async write(text) {
    if (!this.sheet) {
      const { frameTree } = await this.cdp.call('Page.getFrameTree');
      const result = await this.cdp.call('CSS.createStyleSheet', { frameId: frameTree.frame.id, force: true });
      this.sheet = result.styleSheetId;
    }
    await this.cdp.call('CSS.setStyleSheetText', { styleSheetId: this.sheet, text });
  }

  async inspectButton() {
    const { root } = await this.cdp.call('DOM.getDocument');
    const { nodeId } = await this.cdp.call('DOM.querySelector', { nodeId: root.nodeId, selector: '#signal-button' });
    if (!nodeId) throw new Error('The fixture button is not present.');
    const { computedStyle } = await this.cdp.call('CSS.getComputedStyleForNode', { nodeId });
    const values = Object.fromEntries(computedStyle.map(item => [item.name, item.value]));
    return { background: values['background-color'], color: values.color, radius: values['border-top-left-radius'] };
  }

  async remove() {
    return this.enqueue(async () => {
      this.css = '';
      if (this.sheet) await this.write('');
      return this.inspectButton();
    });
  }

  async dispose() {
    this.cdp.off('Page.frameNavigated', this.onNavigation);
    this.cdp.off('Page.loadEventFired', this.onLoad);
    try { await this.remove(); } finally { this.cdp.close(); }
  }
}
