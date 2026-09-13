import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { PipeCDP } from '../lib/pipe-cdp.mjs';

function harness(t, options) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const requests = [];
  let buffer = Buffer.alloc(0);
  outgoing.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    let index;
    while ((index = buffer.indexOf(0)) !== -1) {
      requests.push(JSON.parse(buffer.subarray(0, index).toString('utf8')));
      buffer = buffer.subarray(index + 1);
    }
  });
  const client = new PipeCDP(incoming, outgoing, options);
  t.after(() => client.close());
  const frame = message => Buffer.from(JSON.stringify(message) + '\0', 'utf8');
  return { incoming, outgoing, client, requests, frame };
}

async function attachPage(h, targetId, sessionId) {
  const list = h.client.call('Target.getTargets');
  h.incoming.write(h.frame({ id: h.requests.at(-1).id, result: { targetInfos: [{ targetId, type: 'page' }] } }));
  await list;
  const attach = h.client.call('Target.attachToTarget', { targetId, flatten: true });
  h.incoming.write(h.frame({ id: h.requests.at(-1).id, result: { sessionId } }));
  await attach;
}

test('renderer capability grants only attached sessions and never permits CSP bypass or browser Runtime calls', async t => {
  const h = harness(t), { client, requests, incoming, frame } = h;
  assert.throws(() => client.enableRendererJavaScript('unknown'), /attached page session/);
  await attachPage(h, 'page-a', 'session-a');
  await attachPage(h, 'page-b', 'session-b');
  await assert.rejects(client.call('Runtime.enable', {}, 'session-a'), /not allowed/);
  client.enableRendererJavaScript('session-a');
  for (const [method, params] of [['Runtime.enable', {}], ['Runtime.compileScript', { expression: '1', persistScript: false }],
    ['Runtime.evaluate', { expression: '1', uniqueContextId: 'unique-a', allowUnsafeEvalBlockedByCSP: false }],
    ['Page.createIsolatedWorld', { frameId: 'frame-a', grantUniveralAccess: false }]]) {
    await assert.rejects(client.call(method, params), /not allowed/);
    await assert.rejects(client.call(method, params, 'session-b'), /not allowed/);
    const pending = client.call(method, params, 'session-a');
    assert.equal(requests.at(-1).sessionId, 'session-a');
    incoming.write(frame({ id: requests.at(-1).id, sessionId: 'session-a', result: {} }));
    await pending;
  }
  for (const [method, params] of [['Runtime.evaluate', {}], ['Runtime.evaluate', { allowUnsafeEvalBlockedByCSP: true }],
    ['Page.createIsolatedWorld', {}], ['Page.createIsolatedWorld', { grantUniveralAccess: true }],
    ['Page.createIsolatedWorld', { grantUniveralAccess: false, grantUniversalAccess: true }],
    ['Page.setBypassCSP', { enabled: true }], ['Runtime.runScript', {}], ['Browser.close', {}]]) {
    const count = requests.length; await assert.rejects(client.call(method, params, 'session-a')); assert.equal(requests.length, count);
  }
});

test('Runtime events stay attached-session scoped despite colliding context IDs and are revoked by detach', async t => {
  const h = harness(t), { client, incoming, requests, frame } = h;
  await attachPage(h, 'page-a', 'session-a'); await attachPage(h, 'page-b', 'session-b');
  client.enableRendererJavaScript('session-a');
  const observed = [], generic = [];
  client.on('Runtime.executionContextCreated', (params, sessionId) => observed.push({ uniqueId: params.context.uniqueId, sessionId }));
  client.on('event', event => { if (event.method.startsWith('Runtime.')) generic.push(event); });
  for (const sessionId of ['session-b', 'session-a', undefined]) incoming.write(frame({ method: 'Runtime.executionContextCreated', sessionId,
    params: { context: { id: 1, uniqueId: `unique-${sessionId}`, auxData: { frameId: 'same-frame-label' } } } }));
  assert.deepEqual(observed, [{ uniqueId: 'unique-session-a', sessionId: 'session-a' }]); assert.equal(generic.length, 1);
  incoming.write(frame({ method: 'Runtime.inspectRequested', sessionId: 'session-a', params: {} })); assert.equal(generic.length, 1);
  const pending = client.call('Runtime.enable', {}, 'session-a');
  const refused = assert.rejects(pending, /detached/);
  incoming.write(frame({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-a' } })); await refused;
  incoming.write(frame({ method: 'Runtime.executionContextCreated', sessionId: 'session-a', params: { context: { id: 1, uniqueId: 'late' } } }));
  assert.equal(observed.length, 1);
  await assert.rejects(client.call('Runtime.enable', {}, 'session-a'), /not allowed/);
  assert.throws(() => client.enableRendererJavaScript('session-a'), /attached page session/);
  await attachPage(h, 'page-new', 'session-a');
  await assert.rejects(client.call('Runtime.enable', {}, 'session-a'), /not allowed/);
  client.enableRendererJavaScript('session-a');
  const detach = client.call('Target.detachFromTarget', { sessionId: 'session-a' });
  incoming.write(frame({ id: requests.at(-1).id, result: {} })); await detach;
  await assert.rejects(client.call('Runtime.enable', {}, 'session-a'), /not allowed/);
});

test('mismatched Runtime response sessions close the pipe and reject pending calls', async t => {
  const h = harness(t); await attachPage(h, 'page', 'session'); h.client.enableRendererJavaScript('session');
  const rejected = assert.rejects(h.client.call('Runtime.enable', {}, 'session'), /session did not match/);
  h.incoming.write(h.frame({ id: h.requests.at(-1).id, sessionId: 'other', result: {} }));
  await rejected; assert.throws(() => h.client.enableRendererJavaScript('session'), /attached page session/);
});

test('owned-fixture reload option is default off and still requires an attached granted session', async t => {
  for (const enabled of [false, true]) {
    const h = harness(t, { allowOwnedFixtureReload: enabled });
    await attachPage(h, 'owned-page', 'owned-session');
    await assert.rejects(h.client.call('Page.reload', {}, 'owned-session'), /not allowed/);
    h.client.enableRendererJavaScript('owned-session');
    await assert.rejects(h.client.call('Page.reload'), /not allowed/);
    await assert.rejects(h.client.call('Page.reload', {}, 'other-session'), /not allowed/);
    if (!enabled) await assert.rejects(h.client.call('Page.reload', {}, 'owned-session'), /not allowed/);
    else {
      const reload = h.client.call('Page.reload', {}, 'owned-session');
      h.incoming.write(h.frame({ id: h.requests.at(-1).id, sessionId: 'owned-session', result: {} }));
      await reload;
    }
  }
});

test('pipe correlates concurrent out-of-order responses across UTF-8 and frame boundaries', async t => {
  const { incoming, client, requests, frame } = harness(t);
  const version = client.call('Browser.getVersion');
  const targets = client.call('Target.getTargets');
  assert.deepEqual(requests.map(request => request.method), ['Browser.getVersion', 'Target.getTargets']);
  const combined = Buffer.concat([
    frame({ id: requests[1].id, result: { targetInfos: [{ type: 'page', targetId: 'page', title: '💚' }] } }),
    frame({ id: requests[0].id, result: { product: 'fixture' } })
  ]);
  const split = combined.indexOf(Buffer.from('💚')) + 2;
  incoming.write(combined.subarray(0, split));
  incoming.write(combined.subarray(split));
  assert.equal((await targets).targetInfos[0].title, '💚');
  assert.equal((await version).product, 'fixture');
});

test('pipe requires discovered page attachment and scopes cosmetic calls to that session', async t => {
  const { incoming, client, requests, frame } = harness(t);
  await assert.rejects(client.call('Runtime.evaluate', { expression: '1' }), /not allowed/);
  await assert.rejects(client.call('Target.attachToTarget', { targetId: 'unknown', flatten: true }), /discovered/);
  const list = client.call('Target.getTargets');
  incoming.write(frame({ id: requests.at(-1).id, result: { targetInfos: [{ targetId: 'page', type: 'page' }, { targetId: 'worker', type: 'worker' }] } }));
  await list;
  await assert.rejects(client.call('Target.attachToTarget', { targetId: 'worker', flatten: true }), /discovered/);
  const attach = client.call('Target.attachToTarget', { targetId: 'page', flatten: true });
  incoming.write(frame({ id: requests.at(-1).id, result: { sessionId: 'session' } }));
  await attach;
  await assert.rejects(client.call('CSS.enable'), /session ID/);
  const enable = client.call('CSS.enable', {}, 'session');
  assert.equal(requests.at(-1).sessionId, 'session');
  incoming.write(frame({ id: requests.at(-1).id, result: {}, sessionId: 'session' }));
  await enable;
  await assert.rejects(client.call('CSS.getStyleSheetText', { styleSheetId: 'owned' }), /session ID/);
  const readback = client.call('CSS.getStyleSheetText', { styleSheetId: 'owned' }, 'session');
  assert.equal(requests.at(-1).sessionId, 'session');
  incoming.write(frame({ id: requests.at(-1).id, result: { text: 'button { color: green; }' }, sessionId: 'session' }));
  assert.equal((await readback).text, 'button { color: green; }');
});

test('pipe permits only discovered flattened webviews in addition to pages, keeping other target types and Runtime forbidden', async t => {
  const { incoming, client, requests, frame } = harness(t);
  const forbidden = ['worker', 'shared_worker', 'service_worker', 'iframe', 'browser', 'other'];
  const list = client.call('Target.getTargets');
  incoming.write(frame({ id: requests.at(-1).id, result: { targetInfos: [
    { targetId: 'app-webview', type: 'webview' },
    ...forbidden.map(type => ({ targetId: type, type }))
  ] } }));
  await list;
  for (const targetId of forbidden) {
    await assert.rejects(client.call('Target.attachToTarget', { targetId, flatten: true }), /discovered/);
  }
  await assert.rejects(client.call('Target.attachToTarget', { targetId: 'unknown-webview', flatten: true }), /discovered/);
  await assert.rejects(client.call('Target.attachToTarget', { targetId: 'app-webview', flatten: false }), /flatten/);
  const attach = client.call('Target.attachToTarget', { targetId: 'app-webview', flatten: true });
  incoming.write(frame({ id: requests.at(-1).id, result: { sessionId: 'webview-session' } }));
  await attach;
  const css = client.call('CSS.enable', {}, 'webview-session');
  incoming.write(frame({ id: requests.at(-1).id, result: {}, sessionId: 'webview-session' }));
  await css;
  await assert.rejects(client.call('Runtime.evaluate', { expression: '1' }, 'webview-session'), /not allowed/);
  await assert.rejects(client.call('Target.attachToBrowserTarget'), /not allowed/);
  const changed = client.call('Target.getTargets');
  incoming.write(frame({ id: requests.at(-1).id, result: { targetInfos: [{ targetId: 'app-webview', type: 'iframe' }] } }));
  await changed;
  await assert.rejects(client.call('Target.attachToTarget', { targetId: 'app-webview', flatten: true }), /discovered/);
});

test('pipe close, stream error, malformed frames, and oversized buffers reject all pending calls', async t => {
  for (const failure of ['close', 'error', 'json', 'oversized', 'result']) {
    await t.test(failure, async t => {
      const { incoming, client, requests, frame } = harness(t);
      const checks = [assert.rejects(client.call('Browser.getVersion')), assert.rejects(client.call('Target.getTargets'))];
      if (failure === 'close') client.close();
      if (failure === 'error') incoming.emit('error', new Error('synthetic stream failure'));
      if (failure === 'json') incoming.write(Buffer.from('invalid\0'));
      if (failure === 'oversized') incoming.write(Buffer.alloc(4 * 1024 * 1024 + 1, 65));
      if (failure === 'result') incoming.write(frame({ id: requests[1].id, result: { targetInfos: 'invalid' } }));
      await Promise.all(checks);
      await assert.rejects(client.call('Browser.getVersion'), /closed/);
    });
  }
});

test('pipe expires unanswered calls at eight seconds and tolerates their late responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { incoming, client, requests, frame } = harness(t);
  const rejected = assert.rejects(client.call('Browser.getVersion'), /timed out after 8000 ms/);
  t.mock.timers.tick(8000);
  await rejected;
  incoming.write(frame({ id: requests[0].id, result: { product: 'late' } }));
  const next = client.call('Target.getTargets');
  incoming.write(frame({ id: requests.at(-1).id, result: { targetInfos: [] } }));
  assert.deepEqual(await next, { targetInfos: [] });
});
