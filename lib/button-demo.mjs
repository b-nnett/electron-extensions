import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

export const DEMO_BUTTON_ID = 'extensions-anywhere-demo-button';
export const DEMO_LOG_MESSAGE = '[Extensions Anywhere] Button clicked';

// A fixed, local demonstration scoped by FixtureSession to our signed fixture.
// No arbitrary-script argument or additional target-discovery interface.
export class ButtonDemo extends EventEmitter {
  constructor(cdp) {
    super();
    this.cdp = cdp;
    this.active = false;
    this.context = null;
    this.sheet = null;
    this.queue = Promise.resolve();
    this.reapplication = Promise.resolve();
    this.onNavigation = ({ frame }) => {
      if (!frame.parentId) { this.context = null; this.sheet = null; }
    };
    this.onLoad = () => {
      this.reapplication = this.active ? this.enqueue(() => this.write()) : Promise.resolve();
      this.reapplication.then(() => {
        if (this.active) this.emit('reapplied');
      }, error => this.emit('failure', error));
    };
    this.onConsole = event => {
      if (!this.active || event.executionContextId !== this.context || event.type !== 'log') return;
      if (event.args?.[0]?.value !== DEMO_LOG_MESSAGE) return;
      const clickCount = event.args[1]?.value;
      if (!Number.isSafeInteger(clickCount) || clickCount < 1) return;
      this.emit('console', { message: DEMO_LOG_MESSAGE, clickCount, timestamp: event.timestamp });
    };
  }

  async init() {
    [this.source, this.css] = await Promise.all([
      readFile(new URL('../extensions/button-demo.js', import.meta.url), 'utf8'),
      readFile(new URL('../extensions/button-demo.css', import.meta.url), 'utf8')
    ]);
    this.cdp.on('Page.frameNavigated', this.onNavigation);
    this.cdp.on('Page.loadEventFired', this.onLoad);
    this.cdp.on('Runtime.consoleAPICalled', this.onConsole);
    await this.cdp.call('Runtime.enable');
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async evaluate(expression) {
    if (!this.context) {
      const { frameTree } = await this.cdp.call('Page.getFrameTree');
      const { executionContextId } = await this.cdp.call('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id, worldName: 'extensions-anywhere-button-demo'
      });
      this.context = executionContextId;
    }
    const response = await this.cdp.call('Runtime.evaluate', {
      expression, contextId: this.context, returnByValue: true, timeout: 3000,
      allowUnsafeEvalBlockedByCSP: false
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  }

  async write() {
    if (!this.sheet) {
      const { frameTree } = await this.cdp.call('Page.getFrameTree');
      const result = await this.cdp.call('CSS.createStyleSheet', { frameId: frameTree.frame.id, force: true });
      this.sheet = result.styleSheetId;
    }
    await this.cdp.call('CSS.setStyleSheetText', { styleSheetId: this.sheet, text: this.css });
    const snapshot = await this.evaluate(this.source);
    if (snapshot?.present !== true) throw new Error('Demo script did not add its button.');
    return snapshot;
  }

  install() {
    return this.enqueue(async () => {
      const snapshot = await this.write();
      this.active = true;
      return snapshot;
    });
  }

  remove() {
    return this.enqueue(async () => {
      if (this.context) await this.evaluate(`document.getElementById('${DEMO_BUTTON_ID}')?.remove()`);
      this.active = false;
      if (this.sheet) await this.cdp.call('CSS.setStyleSheetText', { styleSheetId: this.sheet, text: '' });
      return { present: false, clickCount: 0 };
    });
  }

  async dispose() {
    this.cdp.off('Page.frameNavigated', this.onNavigation);
    this.cdp.off('Page.loadEventFired', this.onLoad);
    this.cdp.off('Runtime.consoleAPICalled', this.onConsole);
    await this.remove();
  }
}
