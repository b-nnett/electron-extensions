import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CatalogStylesheet, validateCatalogProfile, selectCatalogCSS, readBoundedJSON, isCatalogAppPage, uniqueCatalogTarget } from '../lib/catalog-stylesheet.mjs';
import { observePaintedCatalogControl, waitForOriginalCatalogControl } from '../scripts/dock-catalog-session.mjs';
import { RuntimeDiagnostics } from '../lib/runtime-diagnostics.mjs';

const profile = validateCatalogProfile({ slug: 'example', name: 'Example', bundlePath: '/Applications/Example.app',
  bundleIdentifier: 'test.example', executable: 'Example', transport: 'pipe', arguments: [],
  target: { urlPattern: '^app://example/index\\.html$', selector: '#known-control' } });
const css = 'button { background: green; }';
const record = (extra = {}) => ({ id: 'one', appKey: profile.bundleIdentifier, name: 'Green', isEnabled: true,
  sourceFileName: 'main.css', sourceType: 'css', sourceText: css, ...extra });

test('curated profile normalization accepts current manifest and rejects path, flag and target overrides', async () => {
  const catalog = JSON.parse(await readFile(new URL('../compatibility/runtime-profiles.json', import.meta.url)));
  for (const entry of catalog) assert.ok(validateCatalogProfile(entry).arguments.length > 0, entry.slug);
  assert.equal(profile.executable, '/Applications/Example.app/Contents/MacOS/Example');
  assert.deepEqual(profile.arguments, ['--remote-debugging-pipe']);
  for (const extra of [{ executable: '/bin/sh' }, { bundlePath: '/Applications/../Example.app' },
    { arguments: ['--no-sandbox'] }, { arguments: ['--user-data-dir=/tmp/example'] },
    { arguments: ['--ignoreAdditionalCommandLineFlags'] }, { target: { selector: 'button', urlPattern: '.*' } }]) {
    assert.throws(() => validateCatalogProfile({ ...profile, ...extra }), /Invalid catalog/);
  }
});

test('selection is isolated to enabled app CSS and preserves nested package order and legacy basename', () => {
  const library = { records: [record({ sourceFiles: [{ fileName: 'css/main.css', type: 'css', text: css },
    { fileName: 'css/second.css', type: 'css', text: 'a { color: white; }' }] }),
    record({ id: 'other', appKey: 'another.app', sourceType: 'js' }), record({ id: 'disabled', isEnabled: false, sourceType: 'js' })] };
  const selected = selectCatalogCSS(library, profile);
  assert.equal(selected.css, css + '\na { color: white; }');
  assert.deepEqual(selected.enabledExtensionIDs, ['one']);
  assert.deepEqual(selected.sources.map(item => item.fileName), ['css/main.css', 'css/second.css']);
  assert.equal(selected.cssBytes, Buffer.byteLength(selected.css));
});

test('selection rejects corrupt packages, enabled JS, duplicate sources and multibyte overflow', () => {
  const cases = [record({ sourceType: 'js' }), record({ sourceFiles: [] }),
    record({ sourceFiles: [{ fileName: 'main.css', type: 'js', text: css }] }),
    record({ sourceFiles: [{ fileName: 'main.css', type: 'css', text: 'different' }] }),
    record({ sourceFileName: 'wrong.css', sourceFiles: [{ fileName: 'main.css', type: 'css', text: css }] }),
    record({ sourceFiles: [{ fileName: 'main.css', type: 'css', text: css }, { fileName: 'main.css', type: 'css', text: css }] }),
    record({ sourceText: '💚'.repeat(16385) })];
  for (const item of cases) assert.throws(() => selectCatalogCSS({ records: [item] }, profile), /Invalid catalog/);
  const exact = record({ sourceText: 'a'.repeat(65536) });
  assert.equal(selectCatalogCSS({ records: [exact] }, profile).cssBytes, 65536);
  assert.throws(() => selectCatalogCSS({ records: [exact, record({ id: 'two', sourceText: '' })] }, profile), /64 KiB/);
  assert.throws(() => selectCatalogCSS({ records: [record(), record()] }, profile), /unique IDs/);
});

test('URL checks constrain origin, strip query/hash and reject dangerous routes and unrelated target types', () => {
  assert.equal(isCatalogAppPage('app://example/index.html?private=value#anchor', profile), true);
  for (const url of ['app://other/index.html', 'app://example:1/index.html', 'app://user@example/index.html',
    'javascript:1', 'data:text/html,test', 'https://example/index.html', 'devtools://example/index.html']) assert.equal(isCatalogAppPage(url, profile), false, url);
  const good = { id: 'one', type: 'page', url: 'app://example/index.html' };
  assert.equal(uniqueCatalogTarget([good, { ...good, type: 'worker' }], profile), good);
  assert.equal(uniqueCatalogTarget([{ ...good, type: 'service_worker' }], profile), null);
  assert.throws(() => uniqueCatalogTarget([good, { ...good, id: 'two', type: 'webview' }], profile), /multiple matching/);
  const electerm = { ...profile, slug: 'electerm', target: { ...profile.target, urlPattern: '^http://127\\.0\\.0\\.1:30975/.*$' } };
  assert.equal(isCatalogAppPage('http://127.0.0.1:30975/', electerm), true);
  for (const url of ['http://127.0.0.1:30976/', 'http://localhost:30975/', 'http://127.0.0.1:30975@elsewhere/']) assert.equal(isCatalogAppPage(url, electerm), false);
});

test('file route containment follows symlinks and bounded JSON rejects invalid UTF-8 and oversize', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'catalog-unit-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const bundle = path.join(folder, 'Example.app'); await mkdir(bundle);
  await writeFile(path.join(bundle, 'index.html'), 'owned test data');
  await writeFile(path.join(folder, 'outside.html'), 'outside');
  await symlink(path.join(folder, 'outside.html'), path.join(bundle, 'escape.html'));
  const local = { ...profile, bundlePath: await import('node:fs/promises').then(fs => fs.realpath(bundle)), target: { selector: '#known', urlPattern: '^file:.*$' } };
  assert.equal(isCatalogAppPage(pathToFileURL(path.join(bundle, 'index.html')).href, local), true);
  assert.equal(isCatalogAppPage(pathToFileURL(path.join(bundle, 'escape.html')).href, local), false);
  const json = path.join(folder, 'data.json'); await writeFile(json, '{"ok":true}');
  assert.deepEqual(await readBoundedJSON(json, 20), { ok: true });
  await assert.rejects(readBoundedJSON(json, 2), /no larger/);
  await writeFile(json, Buffer.from([0xff, 0xfe])); await assert.rejects(readBoundedJSON(json, 20), /UTF-8 JSON/);
});

class Renderer extends EventEmitter {
  text = ''; matches = [2]; calls = []; afterReadback = () => {}; url = 'app://example/index.html'; badReadback = false;
  async call(method, params = {}) {
    this.calls.push({ method, params });
    switch (method) {
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main', url: this.url } } };
      case 'DOM.getDocument': return { root: { nodeId: 1 } };
      case 'DOM.querySelectorAll': return { nodeIds: this.matches };
      case 'CSS.getComputedStyleForNode': return { computedStyle: Object.entries({ 'background-color': this.text ? 'rgb(0, 128, 0)' : 'rgb(0, 0, 0)',
        color: 'rgb(255, 255, 255)', 'border-top-left-radius': '0px', display: 'block', visibility: 'visible', opacity: '1' }).map(([name, value]) => ({ name, value })) };
      case 'DOM.getBoxModel': return { model: { border: [10, 10, 30, 10, 30, 30, 10, 30] } };
      case 'Page.getLayoutMetrics': return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 100, clientHeight: 100 } };
      case 'CSS.createStyleSheet': return { styleSheetId: 'owned' };
      case 'CSS.setStyleSheetText': this.text = params.text; return {};
      case 'CSS.getStyleSheetText': this.afterReadback(); return { text: this.badReadback ? 'wrong' : this.text };
      case 'Page.captureScreenshot': return { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
      default: return {};
    }
  }
}

test('renderer CSS round trip verifies readback, computed baseline, bounded capture and no JS', async () => {
  const renderer = new Renderer(); const styles = new CatalogStylesheet(renderer, profile, async () => {});
  await styles.init(); const original = await styles.control({ visible: true });
  await styles.set(css); assert.notDeepEqual((await styles.control()).computed, original.computed);
  assert.ok((await styles.screenshot(original.clip)).length > 33);
  await styles.dispose(); assert.deepEqual((await styles.control()).computed, original.computed);
  assert.equal(renderer.text, ''); assert.equal(renderer.listenerCount('Page.frameNavigated'), 0);
  assert.equal(renderer.calls.some(item => item.method.startsWith('Runtime.')), false);
});

test('ambiguous control, ownership failure and changed route reject before any CSS mutation', async () => {
  for (const issue of ['duplicates', 'owner', 'route']) {
    const renderer = new Renderer(); if (issue === 'duplicates') renderer.matches = [2, 3]; if (issue === 'route') renderer.url = 'app://other/index.html';
    const styles = new CatalogStylesheet(renderer, profile, async () => { if (issue === 'owner') throw new Error('owner changed'); });
    await assert.rejects(styles.set(css)); assert.equal(renderer.calls.some(item => item.method === 'CSS.createStyleSheet'), false);
  }
});

test('local service renderer requires a bound origin and rejects navigation or lost ownership before CSS writes', async () => {
  const catalog = JSON.parse(await readFile(new URL('../compatibility/runtime-profiles.json', import.meta.url)));
  const local = validateCatalogProfile(catalog.find(item => item.slug === 'antigravity'));
  const renderer = new Renderer(); renderer.url = 'https://127.0.0.1:49666/';
  assert.throws(() => new CatalogStylesheet(renderer, local, async () => {}), /verified local service/);
  assert.throws(() => new CatalogStylesheet(renderer, local, async () => {}, () => {}, { allowUnboundLocalService: true }), /verified local service/);
  let lostOwnership = false;
  const styles = new CatalogStylesheet(renderer, local, async () => { if (lostOwnership) throw new Error('service changed'); },
    () => {}, { ownedServiceOrigin: 'https://127.0.0.1:49666' });
  await styles.init();
  for (const outside of ['https://127.0.0.1:49667/', 'data:text/html,loading', 'https://127.0.0.1:49666/other']) {
    renderer.url = outside; await assert.rejects(styles.set(css), /outside the fixed app route/);
  }
  renderer.url = 'https://127.0.0.1:49666/'; lostOwnership = true;
  await assert.rejects(styles.set(css), /service changed/);
  assert.equal(renderer.calls.some(item => item.method === 'CSS.createStyleSheet' || item.method === 'CSS.setStyleSheetText'), false);
  lostOwnership = false; await styles.set(css); assert.equal(renderer.text, css);
  await styles.dispose(); assert.equal(renderer.text, '');
});

test('cancelled writes stay rejected while owned cleanup can remove CSS without a remaining control', async () => {
  const renderer = new Renderer(); let stopped = false;
  const styles = new CatalogStylesheet(renderer, profile, async () => {}, () => { if (stopped) throw new Error('stopped'); });
  await styles.set(css); stopped = true; await assert.rejects(styles.set('a { color: red; }'), /stopped/);
  renderer.matches = []; await styles.dispose(); assert.equal(renderer.text, '');
});

test('navigation during readback cannot acknowledge active CSS, and reload requires a fresh sheet', async () => {
  const renderer = new Renderer(); const styles = new CatalogStylesheet(renderer, profile, async () => {});
  renderer.afterReadback = () => renderer.emit('Page.frameNavigated', { frame: { id: 'new', url: renderer.url } });
  await assert.rejects(styles.set(css), /navigated/); assert.equal(styles.needsUpdate, true); assert.equal(styles.sheet, null);
  renderer.afterReadback = () => {}; await styles.set(css);
  assert.equal(renderer.calls.filter(item => item.method === 'CSS.createStyleSheet').length, 2);
  assert.equal(styles.needsUpdate, false);
});

test('wrong stylesheet readback and malformed screenshot fail verification', async () => {
  const renderer = new Renderer(); const styles = new CatalogStylesheet(renderer, profile, async () => {});
  renderer.badReadback = true; await assert.rejects(styles.set(css), /did not confirm/);
  const originalCall = renderer.call.bind(renderer);
  renderer.call = (method, params) => method === 'Page.captureScreenshot' ? Promise.resolve({ data: 'bm90IGEgcG5n' }) : originalCall(method, params);
  await assert.rejects(styles.screenshot({ x: 0, y: 0, width: 1, height: 1, scale: 1 }), /bounded PNG/);
});

test('computed observation waits through a CSS transition and restoration before accepting stable values', async () => {
  const renderer = new Renderer(); const styles = new CatalogStylesheet(renderer, profile, async () => {});
  const originalCall = renderer.call.bind(renderer);
  let samples, reads, elapsed = 0;
  renderer.call = async (method, params) => {
    const result = await originalCall(method, params);
    if (method === 'CSS.getComputedStyleForNode') {
      result.computedStyle.find(item => item.name === 'background-color').value = samples[Math.min(reads++, samples.length - 1)];
    }
    return result;
  };
  const timing = { wait: async ms => { elapsed += ms; }, clock: () => elapsed };
  samples = ['old', 'intermediate', 'green', 'green', 'green']; reads = 0;
  const applied = await styles.settledControl(timing);
  assert.equal(applied.computed['background-color'], 'green'); assert.equal(applied.observation.samples, 5);
  assert.equal(applied.observation.elapsedMs, 500);
  samples = ['green', 'intermediate', 'old', 'old', 'old']; reads = 0;
  assert.equal((await styles.settledControl(timing)).computed['background-color'], 'old');
  assert.equal(renderer.calls.some(item => item.method.startsWith('Runtime.') || item.method === 'CSS.setStyleSheetText'), false);
});

test('computed observation is bounded and still rejects navigation and ownership failures', async () => {
  const renderer = new Renderer(); let ownerLost = false;
  const styles = new CatalogStylesheet(renderer, profile, async () => { if (ownerLost) throw new Error('owner changed'); });
  const originalCall = renderer.call.bind(renderer); let count = 0, elapsed = 0;
  renderer.call = async (method, params) => {
    const result = await originalCall(method, params);
    if (method === 'CSS.getComputedStyleForNode') result.computedStyle.find(item => item.name === 'opacity').value = String(++count);
    return result;
  };
  await assert.rejects(styles.settledControl({ wait: async ms => { elapsed += ms; }, clock: () => elapsed }), /did not settle/);
  assert.equal(count, 20); assert.equal(elapsed, 2000);
  await assert.rejects(styles.settledControl({ wait: async () => { renderer.emit('Page.frameNavigated', { frame: { id: 'new' } }); } }), /navigated/);
  ownerLost = true;
  await assert.rejects(styles.settledControl({ wait: async () => {} }), /owner changed/);
});

test('explicit screenshot diagnostics prime a paused renderer before observing applied and restored computed values', async () => {
  const renderer = new Renderer(); const styles = new CatalogStylesheet(renderer, profile, async () => {});
  const originalCall = renderer.call.bind(renderer);
  let paintedText = '';
  renderer.call = async (method, params) => {
    const result = await originalCall(method, params);
    if (method === 'Page.captureScreenshot') paintedText = renderer.text;
    if (method === 'CSS.getComputedStyleForNode') {
      result.computedStyle.find(item => item.name === 'background-color').value = paintedText ? 'green' : 'baseline';
    }
    return result;
  };
  for (const [text, expected] of [[css, 'green'], ['', 'baseline']]) {
    await styles.set(text);
    const previous = (await styles.control()).computed['background-color'];
    assert.notEqual(previous, expected, 'the synthetic renderer retains the previous paint before capture');
    const control = await observePaintedCatalogControl(styles, { diagnostics: new RuntimeDiagnostics({ enabled: true, output: '/tmp' }) });
    assert.equal(control.computed['background-color'], expected);
    assert.equal(control.observation.viewportCapturePrimed, true);
  }
  const captures = renderer.calls.filter(item => item.method === 'Page.captureScreenshot');
  assert.equal(captures.length, 2);
  assert.ok(captures.every(item => item.params.clip === undefined && item.params.captureBeyondViewport === false));
  assert.equal(renderer.calls.some(item => item.method.startsWith('Runtime.')), false);
});

test('failed priming capture never produces a successful computed observation', async () => {
  let observed = false;
  await assert.rejects(observePaintedCatalogControl({
    screenshot: async () => { throw new Error('renderer disconnected'); },
    settledControl: async () => { observed = true; },
  }, { diagnostics: new RuntimeDiagnostics({ enabled: true, output: '/tmp' }) }), /renderer disconnected/);
  assert.equal(observed, false);
});

test('original baseline waits for startup opacity and verifies the settled control is still visible', async () => {
  const renderer = new Renderer(); const styles = new CatalogStylesheet(renderer, profile, async () => {});
  const originalCall = renderer.call.bind(renderer);
  const opacity = ['0.586852', '0.8', '1', '1', '1', '1']; let sample = 0;
  renderer.call = async (method, params) => {
    const result = await originalCall(method, params);
    if (method === 'CSS.getComputedStyleForNode') {
      result.computedStyle.find(item => item.name === 'opacity').value = opacity[Math.min(sample++, opacity.length - 1)];
    }
    return result;
  };
  assert.equal((await styles.control({ visible: true })).computed.opacity, '0.586852');
  const baseline = await observePaintedCatalogControl(styles, { visible: true });
  assert.equal(baseline.computed.opacity, '1');
  assert.ok(baseline.clip.width > 0);
  assert.equal(baseline.observation.viewportCapturePrimed, false);
  assert.equal(renderer.calls.some(item => item.method === 'Page.captureScreenshot'), false);
  assert.ok(baseline.observation.samples >= 4);
  assert.equal(renderer.calls.some(item => item.method === 'CSS.setStyleSheetText' || item.method.startsWith('Runtime.')), false);
});

test('a control that changes after baseline settling is rejected instead of weakening restoration equality', async () => {
  await assert.rejects(observePaintedCatalogControl({
    screenshot: async () => Buffer.alloc(0),
    settledControl: async () => ({ computed: { opacity: '1' } }),
    control: async () => ({ computed: { opacity: '0.5' } }),
  }, { visible: true }), /changed after its bounded settled observation/);
});

test('initial stale-node retry revalidates ownership and queries the replacement node before any CSS write', async () => {
  const renderer = new Renderer(); let ownerChecks = 0, targetChecks = 0, generation = 1, elapsed = 0;
  const styles = new CatalogStylesheet(renderer, profile, async () => { ownerChecks++; });
  const originalCall = renderer.call.bind(renderer);
  renderer.call = async (method, params) => {
    if (method === 'DOM.getDocument') renderer.matches = [++generation];
    if (method === 'CSS.getComputedStyleForNode' && params.nodeId === 2) {
      renderer.calls.push({ method, params });
      throw new Error('CSS.getComputedStyleForNode: Could not find node with given id');
    }
    return originalCall(method, params);
  };
  const settle = styles.settledControl.bind(styles);
  styles.settledControl = () => settle({ wait: async ms => { elapsed += ms; }, clock: () => elapsed });
  const result = await waitForOriginalCatalogControl(styles, {
    validateTarget: async () => { targetChecks++; }, wait: async ms => { elapsed += ms; }, clock: () => elapsed
  });
  assert.equal(targetChecks, 2);
  assert.ok(ownerChecks >= 2);
  assert.equal(result.computed.opacity, '1');
  const reads = renderer.calls.filter(item => item.method === 'CSS.getComputedStyleForNode');
  assert.equal(reads[0].params.nodeId, 2);
  assert.ok(reads.slice(1).every(item => item.params.nodeId > 2), 'no stale node ID is reused');
  assert.equal(renderer.calls.some(item => ['CSS.createStyleSheet', 'CSS.setStyleSheetText'].includes(item.method) || item.method.startsWith('Runtime.')), false);
});

test('initial retry does not mask target ambiguity or an ownership change between attempts', async () => {
  for (const reason of ['multiple matching app pages', 'owner changed']) {
    let reads = 0, checks = 0;
    await assert.rejects(waitForOriginalCatalogControl({
      control: async () => { reads++; throw new Error('CSS.getComputedStyleForNode: Could not find node with given id'); }
    }, { validateTarget: async () => { if (++checks === 2) throw new Error(reason); }, wait: async () => {} }), new RegExp(reason));
    assert.equal(reads, 1);
    assert.equal(checks, 2);
  }
});

test('initial observation retries stay bounded and cancellation stops before the next read', async () => {
  const stale = new Error('DOM.getBoxModel: Could not find node with given id');
  let elapsed = 0, reads = 0;
  await assert.rejects(waitForOriginalCatalogControl({ control: async () => { reads++; throw stale; } }, {
    validateTarget: async () => {}, wait: async ms => { elapsed += ms; }, clock: () => elapsed
  }), error => error === stale);
  assert.equal(elapsed, 15000); assert.equal(reads, 101);
  let stopped = false; reads = 0;
  assert.equal(await waitForOriginalCatalogControl({ control: async () => { reads++; throw stale; } }, {
    validateTarget: async () => {}, stopped: () => stopped, wait: async () => { stopped = true; }
  }), undefined);
  assert.equal(reads, 1);
});

test('non-stale initial failures and stale errors in ordinary applied observations are not retried', async () => {
  for (const message of ['owner changed', 'The selected renderer is outside the fixed app route.',
    'CSS.getComputedStyleForNode timed out.', 'CSS.getComputedStyleForNode: permission denied',
    'The app navigated while reading the control.', 'Invalid or interrupted renderer screenshot.']) {
    let reads = 0, waits = 0;
    await assert.rejects(waitForOriginalCatalogControl({ control: async () => { reads++; throw new Error(message); } }, {
      validateTarget: async () => {}, wait: async () => { waits++; }
    }), error => error.message === message);
    assert.equal(reads, 1); assert.equal(waits, 0);
  }
  let observed = 0;
  await assert.rejects(observePaintedCatalogControl({ screenshot: async () => {}, settledControl: async () => {
    observed++; throw new Error('CSS.getComputedStyleForNode: Could not find node with given id');
  } }), /Could not find node/);
  assert.equal(observed, 1);
});

test('initial target readiness waits for a committed allowed frame without source admission', async () => {
  const { waitForCatalogInitialFrame } = await import('../scripts/dock-catalog-session.mjs');
  const renderer = new Renderer(); renderer.url = 'about:blank'; let metadataChecks = 0, clock = 0;
  const styles = new CatalogStylesheet(renderer, profile, async () => {});
  const observations = [];
  await styles.init({ waitForFrame: () => waitForCatalogInitialFrame(styles, {
    validateTarget: async () => { metadataChecks++; }, stopped: () => false, deadline: 1000, clock: () => clock,
    pause: async ms => { clock += ms; renderer.url = 'app://example/index.html'; }, observe: value => observations.push(value)
  }) });
  assert.equal(metadataChecks, 2); assert.equal(observations.at(-1).state, 'ready');
  assert.equal(observations.at(-1).waitedForCommit, true);
  assert.equal(renderer.calls.some(call => call.method.startsWith('Runtime.') || ['CSS.createStyleSheet', 'CSS.setStyleSheetText'].includes(call.method)), false);
  await styles.set(css); assert.equal(renderer.text, css); await styles.dispose();
});

test('initial readiness refuses stable off-origin roots and records only route classification', async () => {
  const { waitForCatalogInitialFrame } = await import('../scripts/dock-catalog-session.mjs');
  const renderer = new Renderer(); renderer.url = 'https://unexpected.example/private/account?secret=value';
  const styles = new CatalogStylesheet(renderer, profile, async () => {}); const observed = [];
  await assert.rejects(waitForCatalogInitialFrame(styles, { validateTarget: async () => {}, stopped: () => false, deadline: Infinity,
    pause: async () => assert.fail('Off-origin documents are never retried'), observe: value => observed.push(value)
  }), /outside the fixed app route/);
  assert.equal(observed[0].frame.protocol, 'https:'); assert.equal(observed[0].frame.hostname, 'unexpected.example');
  assert.match(observed[0].frame.urlSha256, /^[a-f0-9]{64}$/); assert.doesNotMatch(JSON.stringify(observed), /private|secret|account/);
});

test('blank startup frame wait is bounded and repeats target ownership/ambiguity validation', async () => {
  const { waitForCatalogInitialFrame } = await import('../scripts/dock-catalog-session.mjs');
  const renderer = new Renderer(); renderer.url = 'about:blank';
  const styles = new CatalogStylesheet(renderer, profile, async () => {}); let clock = 0, checks = 0;
  const options = { validateTarget: async () => { checks++; }, stopped: () => false, deadline: 200, clock: () => clock, pause: async ms => { clock += ms; } };
  await assert.rejects(waitForCatalogInitialFrame(styles, options), /startup deadline/); assert.equal(checks, 3);
  clock = 0; checks = 0;
  await assert.rejects(waitForCatalogInitialFrame(styles, { ...options, validateTarget: async () => { if (++checks === 2) throw new Error('target became ambiguous'); } }), /ambiguous/);
  assert.equal(renderer.text, '');
});

test('observed Figma colon sentinel waits for the same allowed document without accepting it as a route', async () => {
  const { waitForCatalogInitialFrame } = await import('../scripts/dock-catalog-session.mjs');
  const figma = validateCatalogProfile(JSON.parse(await readFile(new URL('../compatibility/runtime-profiles.json', import.meta.url))).find(item => item.slug === 'figma'));
  const renderer = new Renderer(); renderer.url = ':';
  const styles = new CatalogStylesheet(renderer, figma, async () => {}); let checks = 0, time = 0;
  assert.equal(isCatalogAppPage(':', figma), false);
  await assert.rejects(styles.frame(), error => error.code === 'CATALOG_INITIAL_FRAME_PENDING');
  const receipt = await waitForCatalogInitialFrame(styles, { validateTarget: async () => { checks++; }, stopped: () => false,
    deadline: 1000, clock: () => time, pause: async ms => { time += ms; renderer.url = 'https://www.figma.com/login'; }
  });
  assert.equal(receipt.state, 'ready'); assert.equal(checks, 2); assert.equal(renderer.text, '');
  assert.equal(renderer.calls.some(call => call.method.startsWith('Runtime.') || call.method.startsWith('CSS.')), false);
  renderer.url = ':';
  const unrelated = new CatalogStylesheet(renderer, profile, async () => {});
  await assert.rejects(waitForCatalogInitialFrame(unrelated, { validateTarget: async () => {}, stopped: () => false,
    deadline: Infinity, pause: async () => assert.fail('Only the validated Figma profile recognizes this sentinel')
  }), /outside the fixed app route/);
});
