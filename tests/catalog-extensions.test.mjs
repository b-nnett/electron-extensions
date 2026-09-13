import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CatalogStylesheet, validateCatalogProfile, supportsCatalogJavaScript, isCatalogJavaScriptPage,
  selectCatalogCSS, selectCatalogExtensions, readCatalogExtensions } from '../lib/catalog-stylesheet.mjs';
import { catalogRendererPage, applyCatalogSources, publishCatalogDebuggerEndpoint, catalogTerminalStatus } from '../scripts/dock-catalog-session.mjs';
import { applyFixtureSources } from '../scripts/dock-fixture-session.mjs';
import { ExtensionSessionLogFile, recoverableExtensionFailure } from '../lib/extension-session-logs.mjs';
import { RuntimeDiagnostics } from '../lib/runtime-diagnostics.mjs';

const profiles = JSON.parse(await readFile(new URL('../compatibility/runtime-profiles.json', import.meta.url)));
const rawVSCode = profiles.find(profile => profile.slug === 'vscode');
const vscode = validateCatalogProfile(rawVSCode);
const rawFigma = profiles.find(profile => profile.slug === 'figma');
const figma = validateCatalogProfile(rawFigma);
const id = '12345678-1234-5678-1234-567812345678';
const record = (overrides = {}) => ({ id, appKey: vscode.bundleIdentifier, name: 'Script', isEnabled: true,
  sourceFileName: 'behavior.js', sourceType: 'js', sourceText: "console.log('owned test');", ...overrides });
const state = (extensionID = id, overrides = {}) => ({ extensionID, revision: 'revision-1', phase: 'active', generation: 1,
  cleanupComplete: false, reloadBlocked: false, fileNames: ['behavior.js'], lastError: null, ...overrides });

class MixedRenderer extends EventEmitter {
  url = 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html';
  text = ''; sheets = 0; badReadback = false;
  async call(method, params = {}) {
    switch (method) {
      case 'Page.enable': case 'DOM.enable': case 'CSS.enable': return {};
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main', url: this.url } } };
      case 'CSS.createStyleSheet': return { styleSheetId: `owned-${++this.sheets}` };
      case 'CSS.setStyleSheetText': this.text = params.text; return {};
      case 'CSS.getStyleSheetText': return { text: this.badReadback ? 'wrong' : this.text };
      default: assert.fail(`Mixed runtime must not inspect a proof control or screenshot: ${method}`);
    }
  }
}

test('mixed CSS and JavaScript apply, reload and cleanup without any vendor proof control', async () => {
  const renderer = new MixedRenderer(), styles = new CatalogStylesheet(renderer, vscode, async () => {});
  const selection = selectCatalogExtensions({ records: [record(), record({ id: randomUUID(),
    sourceFileName: 'appearance.css', sourceType: 'css', sourceText: '.owned-extension { color: green; }' })] }, vscode);
  const scripts = { sync: async () => [state()] };
  await styles.init();
  const first = await applyCatalogSources(styles, scripts, selection);
  assert.equal(first.phase, 'active'); assert.equal(first.stylesheetReadbackVerified, true);
  assert.equal(renderer.text, selection.css);
  renderer.emit('Page.frameNavigated', { frame: { id: 'main', url: renderer.url } });
  const second = await applyCatalogSources(styles, scripts, selection);
  assert.equal(second.phase, 'active'); assert.equal(second.generation, first.generation + 1);
  assert.equal(renderer.sheets, 2);
  await styles.dispose(); assert.equal(renderer.text, '');
  assert.equal(renderer.listenerCount('Page.frameNavigated'), 0);
});

test('mixed stylesheet operation still requires current owner, permitted document and exact readback', async () => {
  for (const issue of ['owner', 'route', 'readback']) {
    const renderer = new MixedRenderer();
    if (issue === 'route') renderer.url = 'https://example.invalid/';
    if (issue === 'readback') renderer.badReadback = true;
    const styles = new CatalogStylesheet(renderer, vscode, async () => { if (issue === 'owner') throw new Error('owner changed'); });
    await assert.rejects(styles.set('.owned-extension { color: green; }'), /owner changed|outside the fixed app route|did not confirm/);
    if (issue !== 'readback') { assert.equal(renderer.sheets, 0); assert.equal(renderer.text, ''); }
  }
});

test('late-discovered TCP endpoint is published only after the listener ownership check succeeds', async () => {
  const report = {}, status = { pid: 123, port: null }, calls = [];
  let release;
  const checked = new Promise(resolve => { release = resolve; });
  const pending = publishCatalogDebuggerEndpoint({ port: 49152, report,
    requireOwner: async () => { calls.push('verify'); await checked; },
    publish: async update => { calls.push('publish'); Object.assign(status, update); } });
  assert.equal(status.port, null); assert.equal(report.debugger, undefined);
  release(); await pending;
  assert.deepEqual(calls, ['verify', 'publish']); assert.equal(status.port, 49152);
  assert.equal(report.debugger.port, 49152); assert.equal(report.debugger.host, '127.0.0.1');
  assert.equal(Number.isFinite(Date.parse(report.debugger.ownershipVerifiedAt)), true);
  const refused = {};
  await assert.rejects(publishCatalogDebuggerEndpoint({ port: 49153, report: refused,
    requireOwner: async () => { throw new Error('wrong owner'); }, publish: async () => assert.fail('must not publish') }), /wrong owner/);
  assert.deepEqual(refused, {});
});

test('terminal status removes the live endpoint and active extension claims without hiding unresolved cleanup', () => {
  for (const errors of [[], ['Imported JavaScript cleanup could not be verified.']]) {
    const report = { errors, revisions: [{ jsStates: [state()], enabledExtensionIDs: [id] }],
      cleanup: { jsCleanupVerified: errors.length === 0 } };
    const status = { phase: 'active', pid: 123, port: 49152, enabledExtensionIDs: [id], cssBytes: 10,
      jsBytes: 20, jsStates: [state()], ...catalogTerminalStatus(report) };
    assert.equal(status.phase, errors.length ? 'error' : 'stopped');
    assert.equal(status.pid, null); assert.equal(status.port, null);
    assert.deepEqual(status.enabledExtensionIDs, []); assert.deepEqual(status.jsStates, []);
    assert.equal(status.cssBytes, 0); assert.equal(status.jsBytes, 0);
    assert.equal(status.error, errors[0] ?? null);
    assert.equal(report.cleanup.jsCleanupVerified, errors.length === 0);
    assert.equal(report.revisions[0].jsStates[0].phase, 'active');
  }
});

test('all 47 catalog profiles explicitly admit the shared renderer engine without claiming live verification', () => {
  assert.equal(supportsCatalogJavaScript(rawVSCode), true);
  assert.equal(supportsCatalogJavaScript(vscode), true);
  const selected = selectCatalogExtensions({ records: [record()] }, vscode);
  assert.equal(selected.hasContent, true); assert.equal(selected.hasCSS, false);
  assert.equal(selected.jsExtensions[0].extensionID, id);
  assert.throws(() => selectCatalogCSS({ records: [record()] }, vscode), /CSS only/);
  assert.equal(supportsCatalogJavaScript(rawFigma), true);
  assert.equal(supportsCatalogJavaScript(figma), true);
  assert.equal(selectCatalogExtensions({ records: [record({ appKey: figma.bundleIdentifier })] }, figma).jsExtensions.length, 1);
  assert.equal(profiles.length, 47);
  for (const profile of profiles) {
    const normalized = validateCatalogProfile(profile);
    assert.deepEqual(profile.rendererRuntime, { engine: 'isolated-js-v1', verification: 'not-verified' });
    assert.equal(supportsCatalogJavaScript(normalized), true, profile.slug);
    const selected = selectCatalogExtensions({ records: [record({ appKey: normalized.bundleIdentifier }),
      record({ id: randomUUID(), appKey: 'unrelated.app' })] }, normalized);
    assert.equal(selected.jsExtensions.length, 1, profile.slug);
    assert.equal(selected.jsExtensions[0].extensionID, id);
    const legacy = { ...normalized, rendererRuntime: undefined };
    assert.equal(supportsCatalogJavaScript(legacy), false);
    assert.throws(() => selectCatalogExtensions({ records: [record({ appKey: normalized.bundleIdentifier })] }, legacy), /CSS only/);
  }
});

test('renderer metadata is strict and cannot loosen either special app by renaming its slug', () => {
  for (const rendererRuntime of [null, {}, { engine: 'other', verification: 'not-verified' },
    { engine: 'isolated-js-v1', verification: 'verified' },
    { engine: 'isolated-js-v1', verification: 'not-verified', bypassCSP: true }]) {
    assert.throws(() => validateCatalogProfile({ ...rawVSCode, rendererRuntime }), /rendererRuntime/);
    assert.equal(supportsCatalogJavaScript({ ...rawVSCode, rendererRuntime }), false);
  }
  for (const profile of [vscode, figma]) {
    assert.equal(supportsCatalogJavaScript({ ...profile, slug: 'renamed', target: { ...profile.target, urlPattern: '^.*$' } }), false);
  }
});

test('generic JavaScript routes retain app origins and owned local-service binding across sign-in', () => {
  const slack = validateCatalogProfile(profiles.find(profile => profile.slug === 'slack'));
  for (const url of ['https://app.slack.com/ssb/first/', 'https://app.slack.com/client/workspace/channel']) {
    assert.equal(isCatalogJavaScriptPage(url, slack), true);
  }
  const notion = validateCatalogProfile(profiles.find(profile => profile.slug === 'notion'));
  for (const url of ['https://app.notion.com/login', 'https://app.notion.com/workspace/owned-page']) {
    assert.equal(isCatalogJavaScriptPage(url, notion), true);
  }
  for (const url of ['https://app.notion.com.evil.invalid/workspace', 'https://user@app.notion.com/workspace', 'https://app.notion.com:8443/workspace']) {
    assert.equal(isCatalogJavaScriptPage(url, notion), false);
  }
  for (const url of ['https://other.slack.com/ssb/first/',
    'http://app.slack.com/ssb/first/', 'https://user@app.slack.com/ssb/first/', 'devtools://app.slack.com/ssb/first/']) {
    assert.equal(isCatalogJavaScriptPage(url, slack), false, url);
  }
  const local = validateCatalogProfile(profiles.find(profile => profile.slug === 'antigravity'));
  const route = { ownedServiceOrigin: 'https://127.0.0.1:49666' };
  assert.equal(isCatalogJavaScriptPage(route.ownedServiceOrigin + '/', local, route), true);
  assert.equal(isCatalogJavaScriptPage(route.ownedServiceOrigin + '/', local), false);
  assert.equal(isCatalogJavaScriptPage('https://127.0.0.1:49667/', local, route), false);
  assert.equal(isCatalogJavaScriptPage(route.ownedServiceOrigin + '/other', local, route), false);
});

test('Figma JavaScript remains on its fixed app and HTTPS origin across document navigation', () => {
  for (const changes of [
    { name: 'Figma Beta' }, { bundleIdentifier: 'other' }, { bundlePath: '/Applications/Other.app' },
    { executable: '/Applications/Figma.app/Contents/MacOS/Other' }, { transport: 'tcp' },
    { arguments: ['--remote-debugging-port=0'] }, { arguments: ['--remote-debugging-pipe', '--remote-debugging-pipe'] },
    { target: { ...figma.target, selector: 'body' } }, { target: { ...figma.target, urlPattern: '^https://www\\.figma\\.com/.*$' } },
    { ownedLocalService: {} }
  ]) assert.equal(supportsCatalogJavaScript({ ...figma, ...changes }), false);
  for (const url of ['https://www.figma.com/login', 'https://www.figma.com/login/?state=unrecorded#fragment', 'https://www.figma.com/files', 'https://www.figma.com/file/owned', 'https://www.figma.com/design/owned']) {
    assert.equal(isCatalogJavaScriptPage(url, figma), true);
  }
  for (const url of ['https://figma.com/login', 'https://www.figma.com.evil.invalid/login', 'https://user@www.figma.com/login',
    'https://www.figma.com:8000/login', 'http://www.figma.com/login', 'file:///Applications/Figma.app/Contents/Resources/app.asar/shell.html']) {
    assert.equal(isCatalogJavaScriptPage(url, figma), false, url);
  }
});

test('profile flag, route, control, transport or executable drift cannot enable vendor JavaScript', () => {
  for (const changes of [
    { slug: 'other' }, { bundleIdentifier: 'other' }, { bundlePath: '/Applications/Other.app' },
    { executable: '/Applications/Other.app/Contents/MacOS/Code' }, { transport: 'pipe' },
    { arguments: ['--no-sandbox'] }, { arguments: ['--remote-debugging-port=0', '--remote-debugging-port=0'] },
    { target: { ...vscode.target, selector: 'body' } }, { target: { ...vscode.target, urlPattern: '^.*$' } },
    { ownedLocalService: {} }
  ]) {
    const profile = { ...vscode, ...changes };
    assert.equal(supportsCatalogJavaScript(profile), false);
    assert.throws(() => selectCatalogExtensions({ records: [record({ appKey: profile.bundleIdentifier })] }, profile), /CSS only/);
  }
});

test('JavaScript page route is the ordinary VSCode workbench, excluding other origins and documents', () => {
  const url = 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html';
  assert.equal(isCatalogJavaScriptPage(url, vscode), true);
  assert.equal(isCatalogJavaScriptPage(url + '?windowId=1#state', vscode), true);
  for (const other of [url.replace('vscode-app', 'unrelated'), url.replace('workbench.html', 'login.html'),
    url.replace('Visual%20Studio%20Code.app', 'Other.app'), url.replace('vscode-file:', 'https:'),
    url.replace('vscode-app/', 'user@vscode-app/'), url.replace('vscode-app/', 'vscode-app:8000/'),
    'vscode-file://vscode-app/tmp/workbench.html', 'about:blank']) assert.equal(isCatalogJavaScriptPage(other, vscode), false);
});

test('catalog transport forwards renderer context events only to the permitted JavaScript profile', async () => {
  const slack = validateCatalogProfile(profiles.find(profile => profile.slug === 'slack'));
  for (const [profile, allowed] of [[vscode, true], [figma, true], [slack, true], [{ ...slack, rendererRuntime: undefined }, false]]) {
    const transport = new EventEmitter(), observed = [], called = [];
    let checks = 0;
    const page = catalogRendererPage({ transport, profile, requireOwner: async () => { checks++; }, diagnostics: new RuntimeDiagnostics(),
      call: async (method, params) => { called.push([method, params]); return {}; } });
    const events = ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Runtime.executionContextCreated',
      'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Page.loadEventFired'];
    for (const event of events) { page.on(event, () => observed.push(event)); transport.emit(event, { test: true }); }
    assert.deepEqual(observed, allowed ? events : []);
    for (const [method, params] of [['Runtime.enable', {}], ['Runtime.compileScript', {}],
      ['Runtime.evaluate', { allowUnsafeEvalBlockedByCSP: false }], ['Page.createIsolatedWorld', { grantUniveralAccess: false }]]) {
      if (allowed) await page.call(method, params);
      else await assert.rejects(page.call(method, params), /does not permit/);
    }
    assert.equal(checks, allowed ? 4 : 0);
    assert.equal(called.length, allowed ? 4 : 0);
    for (const [method, params] of [['Page.setBypassCSP', { enabled: true }], ['Page.reload', {}], ['Browser.close', {}],
      ['Runtime.evaluate', { allowUnsafeEvalBlockedByCSP: true }], ['Page.createIsolatedWorld', { grantUniveralAccess: true }]]) {
      await assert.rejects(page.call(method, params));
    }
    await assert.rejects(page.call('Page.captureScreenshot'), /screenshots are disabled/);
  }
});

test('transport identity refusal prevents Runtime calls and scoped sessions do not forward other page events', async () => {
  const transport = new EventEmitter(); let calls = 0, events = 0;
  const page = catalogRendererPage({ transport, profile: vscode, diagnostics: new RuntimeDiagnostics(), sessionID: 'owned',
    requireOwner: async () => { throw new Error('identity changed'); }, call: async () => { calls++; } });
  page.on('Runtime.consoleAPICalled', () => events++);
  transport.emit('Runtime.consoleAPICalled', {}, 'other');
  transport.emit('Runtime.consoleAPICalled', {}, 'owned');
  assert.equal(events, 1);
  await assert.rejects(page.call('Runtime.enable'), /identity changed/);
  assert.equal(calls, 0);
});

test('JS-only catalog application skips fixed-control inspection and preserves healthy source on recoverable failure', async () => {
  const selection = selectCatalogExtensions({ records: [record(), record({ id: randomUUID() })] }, vscode);
  const calls = [];
  const healthy = state(id), failed = state(selection.jsExtensions[1].extensionID, { phase: 'failed', cleanupComplete: true,
    lastError: { fileName: 'behavior.js', stage: 'load', message: 'private script detail' } });
  const styles = { set: async css => { calls.push(['css', css]); return { generation: 1, stylesheetReadbackVerified: true }; },
    control: () => { throw new Error('must not inspect fixed control'); } };
  const scripts = { sync: async definitions => {
    calls.push(['scripts', definitions]); throw Object.assign(new Error('load failed'), { states: [healthy, failed] });
  } };
  const result = await applyCatalogSources(styles, scripts, selection);
  assert.equal(result.phase, 'error'); assert.equal(result.jsStates[0].phase, 'active'); assert.equal(result.jsStates[1].phase, 'failed');
  assert.deepEqual(calls.map(call => call[0]), ['css', 'scripts']);
  assert.equal(calls[0][1], ''); assert.equal(calls[1][1].length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private script detail/);
  assert.equal(recoverableExtensionFailure({ states: [healthy, failed] }), true);
  for (const states of [[], [healthy], [{ ...healthy, reloadBlocked: true }, failed],
    [{ ...failed, cleanupComplete: false }], [{ ...failed, reloadBlocked: true }]]) {
    assert.equal(recoverableExtensionFailure({ states }), false);
  }
  scripts.sync = async () => { throw Object.assign(new Error('cleanup uncertain'), { states: [{ ...failed, cleanupComplete: false }] }); };
  await assert.rejects(applyCatalogSources(styles, scripts, selection), /cleanup uncertain/);
});

test('fixture uses the same recoverable failure semantics without disposing healthy independent source', async () => {
  const definitions = [{ extensionID: id, revision: 'revision-1', files: [] }];
  const failed = state(randomUUID(), { phase: 'failed', cleanupComplete: true });
  const session = { styles: { remove: async () => ({ baseline: true }) }, extensions: {
    sync: async selected => { assert.equal(selected, definitions); throw Object.assign(new Error('safe failure'), { states: [state(), failed] }); }
  } };
  const result = await applyFixtureSources(session, { hasCSS: false, hasContent: true, jsExtensions: definitions });
  assert.equal(result.phase, 'error'); assert.equal(result.jsStates[0].phase, 'active');
});

test('catalog log persistence and file selection bind the VSCode app and native UUID without sources', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'catalog-extension-test-'));
  try {
    const file = path.join(directory, 'library.json'), input = { records: [record()] };
    await writeFile(file, JSON.stringify(input));
    assert.deepEqual(await readCatalogExtensions(file, vscode), selectCatalogExtensions(input, vscode));
    const sessionID = randomUUID(), log = path.join(directory, 'extension-logs.json');
    const logger = new ExtensionSessionLogFile(log, sessionID, { appKey: vscode.bundleIdentifier });
    await logger.append({ extensionID: id, revision: 'revision-1', fileName: 'behavior.js', level: 'log',
      timestamp: new Date().toISOString(), message: 'explicit handler output', sourceText: 'do not persist' });
    const saved = JSON.parse(await readFile(log));
    assert.equal(saved.appKey, 'com.microsoft.VSCode'); assert.equal(saved.sessionID, sessionID);
    assert.equal(saved.schema, 1); assert.doesNotMatch(JSON.stringify(saved), /do not persist/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
