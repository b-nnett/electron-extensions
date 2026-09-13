import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OwnedCatalogLocalService, soleIPv4LoopbackListener, localServicePageURL } from '../lib/owned-local-service.mjs';
import { validateCatalogProfile, isCatalogAppPage, uniqueCatalogTarget } from '../lib/catalog-stylesheet.mjs';

const catalog = JSON.parse(await readFile(new URL('../compatibility/runtime-profiles.json', import.meta.url)));
const rawProfile = catalog.find(item => item.slug === 'antigravity');
const profile = validateCatalogProfile(rawProfile);
const main = { pid: 100, started: '1788901000.123456', uid: 501, ppid: 90, executable: profile.executable };
const executable = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
const service = { pid: 101, started: '1788901001.123456', uid: 501, ppid: 100, executable };
const url = 'https://127.0.0.1:49666/';
const discovery = { allowUnboundLocalService: true }, bound = { ownedServiceOrigin: 'https://127.0.0.1:49666' };

function fixture() {
  const state = { main: { ...main }, service: { ...service }, listener: 'p101\nn127.0.0.1:49666\n',
    canonical: executable, regularFile: true, inode: 20n, ports: [], reads: [] };
  const owner = new OwnedCatalogLocalService(profile, main, {
    readIdentity: async pid => { state.reads.push(pid); return pid === main.pid ? state.main : state.service; },
    listeners: async port => { state.ports.push(port); return state.listener; },
    canonicalize: async file => { assert.equal(file, executable); return state.canonical; },
    inspectFile: async file => { assert.equal(file, executable); return { isFile: () => state.regularFile,
      dev: 1n, ino: state.inode, size: 100n, mtimeNs: 200n, ctimeNs: 300n }; }
  });
  return { state, owner };
}

test('local service descriptor is limited to the exact reviewed app, route and harmless control', () => {
  assert.equal(profile.target.selector, 'button[aria-label="Toggle Sidebar"][data-testid="sidebar-toggle"]');
  assert.deepEqual(profile.arguments, ['--remote-debugging-pipe']);
  for (const change of [{ slug: 'other' }, { bundleIdentifier: 'other.app' }, { bundlePath: '/Applications/Other.app' },
    { executable: 'Other' }, { transport: 'tcp' }, { ownedLocalService: undefined }, { ownedLocalService: null },
    { ownedLocalService: { executableRelativePath: '../language_server' } },
    { ownedLocalService: { executableRelativePath: 'Contents/Resources/bin/language_server', port: 49666 } },
    { target: { ...profile.target, selector: 'button' } }, { target: { ...profile.target, urlPattern: '^https:.*$' } }]) {
    assert.throws(() => validateCatalogProfile({ ...rawProfile, ...change }), /Invalid catalog/);
  }
});

test('dynamic roots require explicit discovery or the bound origin and reject URL normalization tricks', () => {
  assert.equal(isCatalogAppPage(url, profile), false);
  assert.equal(isCatalogAppPage(url, profile, discovery), true);
  assert.equal(isCatalogAppPage(url, profile, bound), true);
  assert.equal(isCatalogAppPage('https://127.0.0.1:49667/', profile, bound), false);
  for (const bad of ['data:text/html,loading', 'http://127.0.0.1:49666/', 'https://localhost:49666/',
    'https://127.0.0.1:49666/path', 'https://127.0.0.1:49666/?q=private', 'https://127.0.0.1:49666/#other',
    'https://user@127.0.0.1:49666/', 'https://127.0.0.1:49666@other/', 'https://127.0.0.1:49666',
    'https://127.0.0.1:1023/', 'https://127.0.0.1:65536/', 'https://127.0.0.1:049666/',
    'https://127.1:49666/', 'https://2130706433:49666/', 'HTTPS://127.0.0.1:49666/',
    'https://127.0.0.1:49666/../', 'https://127.0.0.1:49666/\n']) {
    assert.equal(localServicePageURL(bad, profile), null, bad);
    assert.equal(isCatalogAppPage(bad, profile, discovery), false, bad);
  }
  for (const port of [1024, 65535]) assert.ok(localServicePageURL(`https://127.0.0.1:${port}/`, profile));
});

test('local service selection ignores overlays and workers but rejects two production roots', () => {
  const page = { targetId: 'app', type: 'page', url };
  assert.equal(uniqueCatalogTarget([page], profile), null);
  assert.equal(uniqueCatalogTarget([page, { ...page, type: 'webview' }, { ...page, type: 'worker' },
    { ...page, targetId: 'loading', url: 'data:text/html,omitted' }], profile, discovery), page);
  assert.throws(() => uniqueCatalogTarget([page, { ...page, targetId: 'second', url: 'https://127.0.0.1:49667/' }], profile, discovery), /multiple matching/);
});

test('listener parser requires one process and exactly one IPv4 loopback socket', () => {
  assert.equal(soleIPv4LoopbackListener('p101\nn127.0.0.1:49666\n', 49666), 101);
  for (const input of ['', 'n127.0.0.1:49666\n', 'p101\nn*:49666\n', 'p101\nn[::1]:49666\n',
    'p101\nn127.0.0.1:49667\n', 'p101\nn127.0.0.1:49666\nn127.0.0.1:49666\n',
    'p101\nn127.0.0.1:49666\np102\nn127.0.0.1:49666\n',
    'p101\nn127.0.0.1:49666\np102\n', 'p101\nn127.0.0.1:49666\nunknown\n',
    'p2147483648\nn127.0.0.1:49666\n']) assert.equal(soleIPv4LoopbackListener(input, 49666), null, input);
});

test('macOS descriptor fields identify one socket without accepting extra or malformed records', () => {
  for (const fd of [0, 53, 2147483647]) {
    assert.equal(soleIPv4LoopbackListener(`p101\nf${fd}\nn127.0.0.1:49666\n`, 49666), 101);
  }
  assert.equal(soleIPv4LoopbackListener('p101\nf53\nn127.0.0.1:49666', 49666), 101);
  for (const input of ['p101\nf53\nn*:49666\n', 'p101\nf53\nn[::1]:49666\n',
    'p101\nf53\nn127.0.0.1:49667\n', 'p101\nf53\nn127.0.0.1:49666\nf54\nn127.0.0.1:49666\n',
    'p101\nf53\nn127.0.0.1:49666\np102\nf54\nn127.0.0.1:49666\n',
    'p101\nf53\nf54\nn127.0.0.1:49666\n', 'p101\nf53\nn127.0.0.1:49666\nn127.0.0.1:49666\n',
    'p101\nf53\nn127.0.0.1:49666\nunknown\n', 'p101\nf53\nn127.0.0.1:49666\np102\n',
    'p101\nf53u\nn127.0.0.1:49666\n', 'p101\nftxt\nn127.0.0.1:49666\n',
    'p101\nf-1\nn127.0.0.1:49666\n', 'p101\nf053\nn127.0.0.1:49666\n',
    'p101\nf2147483648\nn127.0.0.1:49666\n', 'p101\nf\nn127.0.0.1:49666\n',
    'f53\np101\nn127.0.0.1:49666\n', 'p101\nn127.0.0.1:49666\nf53\n',
    'p2147483648\nf53\nn127.0.0.1:49666\n']) {
    assert.equal(soleIPv4LoopbackListener(input, 49666), null, input);
  }
});

test('descriptor-form listeners still require exact service ownership and permanently reject replacement', async () => {
  for (const change of [{ ppid: 99 }, { uid: 502 }, { executable: '/tmp/language_server' },
    { started: '1788901000.123455' }, { started: 'unknown' }, { pid: 102 }]) {
    const { state, owner } = fixture(); state.listener = 'p101\nf53\nn127.0.0.1:49666\n';
    Object.assign(state.service, change);
    await assert.rejects(owner.bind(url), /direct child|start time/);
    assert.equal(owner.evidence, null);
  }
  const { state, owner } = fixture(); state.listener = 'p101\nf53\nn127.0.0.1:49666\n';
  assert.deepEqual((await owner.bind(url)).processIdentity, service);
  await owner.check();
  state.service.started = '1788901003.000000';
  await assert.rejects(owner.check(), /identity changed/);
  state.service = { ...service };
  await assert.rejects(owner.check(), /start a new session/);
});

test('binding records the exact packaged direct child and rechecks the pinned listener without rebinding', async () => {
  const { state, owner } = fixture();
  await assert.rejects(owner.check(), /not been verified/);
  const evidence = await owner.bind(url);
  assert.equal(evidence.origin, bound.ownedServiceOrigin); assert.deepEqual(evidence.processIdentity, service);
  evidence.processIdentity.pid = 999;
  assert.equal(owner.evidence.processIdentity.pid, service.pid);
  await owner.check(); await owner.check({ ...main });
  assert.deepEqual(state.ports, [49666, 49666, 49666]);
  assert.deepEqual(state.reads, [100, 101, 100, 101, 101]);
  await assert.rejects(owner.bind('https://127.0.0.1:49667/'), /cannot be rebound/);
});

test('wrong parent, user, executable or older process cannot establish service ownership', async () => {
  for (const change of [{ ppid: 99 }, { uid: 502 }, { executable: '/tmp/language_server' },
    { started: '1788901000.123455' }, { started: 'unknown' }, { pid: 0 }, { pid: 102 }]) {
    const { state, owner } = fixture(); Object.assign(state.service, change);
    await assert.rejects(owner.bind(url), /direct child|start time/);
    assert.equal(owner.evidence, null);
  }
  const { state, owner } = fixture(); state.service = null;
  await assert.rejects(owner.bind(url), /direct child/);
});

test('PID reuse, service replacement and reparenting permanently stop an established session', async () => {
  for (const change of ['main-reused', 'main-absent', 'service-reused', 'service-replaced', 'reparented']) {
    const { state, owner } = fixture(); await owner.bind(url);
    if (change === 'main-reused') state.main.started = '1788901002.000000';
    if (change === 'main-absent') state.main = null;
    if (change === 'service-reused') state.service.started = '1788901003.000000';
    if (change === 'service-replaced') { state.listener = 'p102\nn127.0.0.1:49666\n'; state.service.pid = 102; }
    if (change === 'reparented') state.service.ppid = 1;
    await assert.rejects(owner.check(), /changed|direct child/);
    state.main = { ...main }; state.service = { ...service }; state.listener = 'p101\nn127.0.0.1:49666\n';
    await assert.rejects(owner.check(), /start a new session/);
  }
});

test('filesystem changes and listener ownership ambiguity reject before another renderer operation', async () => {
  for (const change of ['symlink', 'not-file', 'replaced-file', 'no-listener', 'other-listener']) {
    const { state, owner } = fixture(); await owner.bind(url);
    if (change === 'symlink') state.canonical = '/tmp/language_server';
    if (change === 'not-file') state.regularFile = false;
    if (change === 'replaced-file') state.inode = 99n;
    if (change === 'no-listener') state.listener = '';
    if (change === 'other-listener') state.listener += 'p102\nn127.0.0.1:49666\n';
    await assert.rejects(owner.check(), /path changed|regular file|file changed|sole IPv4/);
  }
});
