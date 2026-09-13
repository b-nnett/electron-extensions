import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CDP, StylesheetController } from './cdp.mjs';
import { ButtonDemo } from './button-demo.mjs';
import { RendererScriptController } from './renderer-script-controller.mjs';
import { inspectIntegrity, compareIntegrity } from './integrity.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureBundle = path.join(root, 'dist', `Style Lab-darwin-${process.arch}`, 'Style Lab.app');
export const installedFixtureBundle = '/Applications/Style Lab.app';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class FixtureSession {
  constructor({ installedFixture = false, enableButtonDemo = true, enableImportedExtensions = false } = {}) {
    if ([installedFixture, enableButtonDemo, enableImportedExtensions].some(value => typeof value !== 'boolean')) throw new TypeError('Fixture options must be booleans.');
    this.bundle = installedFixture ? installedFixtureBundle : fixtureBundle;
    this.enableButtonDemo = enableButtonDemo;
    this.enableImportedExtensions = enableImportedExtensions;
  }

  async start() {
    if (this.child) throw new Error('The test app is already running.');
    if (![fixtureBundle, installedFixtureBundle].includes(this.bundle)) throw new Error('Only the project-owned Style Lab fixture is supported.');
    this.before = await inspectIntegrity(this.bundle);
    this.profile = await mkdtemp(path.join(tmpdir(), 'extensions-anywhere-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(path.join(this.bundle, 'Contents/MacOS/Style Lab'), [
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.profile}`
    ], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    this.launchArguments = [...this.child.spawnargs];
    try {
      this.port = await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => finish(new Error('Test app did not expose its debugger in 20 seconds.')), 20000);
        const finish = (error, port) => {
          clearTimeout(timer);
          this.child.stderr.off('data', onData);
          this.child.off('error', onError);
          this.child.off('exit', onExit);
          error ? reject(error) : resolve(port);
        };
        const onData = chunk => {
          buffer = (buffer + chunk.toString()).slice(-16000);
          const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
          if (match) finish(null, Number(match[1]));
        };
        const onError = error => finish(error);
        const onExit = code => finish(new Error(`Test app exited during startup (${code}). ${buffer.slice(-1200)}`));
        this.child.stderr.on('data', onData);
        this.child.once('error', onError);
        this.child.once('exit', onExit);
      });
      // Drain subsequent logs without persisting their contents.
      this.child.stderr.resume();
      const expected = pathToFileURL(path.join(this.bundle, 'Contents/Resources/app.asar/index.html')).href;
      let target;
      for (let attempt = 0; attempt < 60; attempt++) {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2000) });
        const targets = await response.json();
        target = targets.find(item => item.type === 'page' && item.url === expected);
        if (target?.webSocketDebuggerUrl) break;
        await delay(150);
      }
      if (!target?.webSocketDebuggerUrl) throw new Error('The signed fixture page was not exposed.');
      const socketURL = new URL(target.webSocketDebuggerUrl);
      if (socketURL.port !== String(this.port)) throw new Error('Debugger endpoint does not match the launched fixture.');
      this.cdp = new CDP(socketURL.href, this.enableImportedExtensions ? 12000 : 6000);
      await this.cdp.ready;
      this.styles = new StylesheetController(this.cdp);
      await this.styles.init();
      if (this.enableButtonDemo) {
        this.buttonDemo = new ButtonDemo(this.cdp);
        await this.buttonDemo.init();
      }
      if (this.enableImportedExtensions) {
        this.extensions = new RendererScriptController({ cdp: this.cdp, appName: 'Style Lab', assertPage: async () => {
          if (![fixtureBundle, installedFixtureBundle].includes(this.bundle) || !this.child || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('The owned Style Lab session is no longer running.');
          const { frameTree } = await this.cdp.call('Page.getFrameTree');
          const expected = pathToFileURL(path.join(this.bundle, 'Contents/Resources/app.asar/index.html')).href;
          if (frameTree.frame.url !== expected) throw new Error('The selected page is outside the owned Style Lab fixture.');
          return frameTree.frame.id;
        } });
        await this.extensions.init();
      }
      this.original = await this.styles.inspectButton();
      return { pid: this.child.pid, port: this.port, signature: this.before, button: this.original };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async verify() {
    if (!this.before) throw new Error('Launch the test app before checking its integrity.');
    return compareIntegrity(this.before, await inspectIntegrity(this.bundle));
  }

  async reload() {
    if (!this.cdp || !this.styles) throw new Error('Launch the test app first.');
    const cdp = this.cdp;
    const styles = this.styles;
    const buttonDemo = this.buttonDemo;
    const extensions = this.extensions;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        cdp.off('Page.loadEventFired', loaded);
        cdp.off('disconnected', disconnected);
      };
      const fail = error => { cleanup(); reject(error); };
      const loaded = async () => {
        cleanup();
        try {
          // The controller's load listener enqueues reapplication before this one.
          await styles.reapplication;
          await styles.queue;
          await buttonDemo?.reapplication;
          await buttonDemo?.queue;
          await extensions?.reapplication;
          await extensions?.queue;
          resolve(await styles.inspectButton());
        } catch (error) { reject(error); }
      };
      const disconnected = () => fail(new Error('Test app disconnected while reloading.'));
      const timer = setTimeout(() => fail(new Error('Test app reload timed out.')), 10000);
      cdp.once('Page.loadEventFired', loaded);
      cdp.once('disconnected', disconnected);
      cdp.call('Page.reload').catch(fail);
    });
  }

  async stop() {
    if (this.extensions) {
      try { await this.extensions.dispose(); }
      catch (error) { this.extensionCleanupError = error.message; }
    }
    this.extensions = null;
    if (this.buttonDemo) await this.buttonDemo.dispose().catch(() => {});
    this.buttonDemo = null;
    if (this.styles) await this.styles.dispose().catch(() => {});
    this.styles = null;
    this.cdp?.close();
    this.cdp = null;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    if (child) this.lastExit = { pid: child.pid, code: child.exitCode, signal: child.signalCode };
    this.child = null;
    if (this.profile) await rm(this.profile, { recursive: true, force: true });
    this.profile = null;
  }
}
