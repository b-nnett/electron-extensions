import test from 'node:test';
import assert from 'node:assert/strict';
import { StylesheetRemoval } from '../lib/stylesheet-removal.mjs';

// A synthetic owned window exercises real cleanup orchestration without an app,
// inspector, renderer evaluation, or changes to vendor/user data.
function fixture() {
  const styles = new Map([['unrelated', 'existing user stylesheet']]);
  const saved = [];
  let connected = true, owner = 'original', route = '/new', inserts = 0, reconnects = 0;
  const tracker = new StylesheetRemoval(async () => saved.push({ ...tracker.state }));
  const requireOwner = async () => { if (owner !== 'original') throw new Error('Owner changed'); };
  const insert = async () => {
    await requireOwner();
    if (!connected) throw new Error('Disconnected');
    if (route !== '/new') throw new Error('Route changed');
    inserts++;
    styles.set('owned-key', 'fixed green');
    return 'owned-key';
  };
  const cleanup = () => tracker.remove({
    remove: async key => {
      await requireOwner();
      if (!connected) throw new Error('Disconnected');
      assert.equal(key, 'owned-key');
      styles.delete(key);
    },
    checkAfter: requireOwner,
    disconnected: () => !connected,
    reconnect: async () => { await requireOwner(); reconnects++; connected = true; }
  });
  return { tracker, styles, saved, insert, cleanup, requireOwner,
    setConnected: value => { connected = value; },
    setOwner: value => { owner = value; },
    setRoute: value => { route = value; },
    counts: () => ({ inserts, reconnects }) };
}

test('fixed stylesheet removal preserves unrelated styles and persists each state', async () => {
  const f = fixture();
  await f.tracker.insert(f.insert, f.requireOwner);
  assert.equal(f.styles.get('owned-key'), 'fixed green');
  assert.equal(f.tracker.state.key, 'owned-key');
  assert.equal(await f.cleanup(), true);
  assert.deepEqual([...f.styles], [['unrelated', 'existing user stylesheet']]);
  assert.deepEqual(f.saved.map(s => s.status), ['insertion-pending', 'removal-pending', 'removed']);
});

test('post-insertion verification failure retains and persists the key before throwing', async () => {
  const f = fixture();
  await assert.rejects(f.tracker.insert(f.insert, async () => {
    assert.deepEqual(f.saved.at(-1), { status: 'removal-pending', key: 'owned-key' });
    throw new Error('Post-call check failed');
  }), /Post-call check failed/);
  assert.equal(f.tracker.state.key, 'owned-key');
  await f.cleanup();
  assert.equal(f.styles.has('owned-key'), false);
});

test('interruption after insertion response still permits exact-key cleanup', async () => {
  const f = fixture();
  let interrupted = false;
  await assert.rejects(f.tracker.insert(async () => {
    const key = await f.insert();
    interrupted = true;
    return key;
  }, async () => { if (interrupted) throw new Error('Interrupted'); }), /Interrupted/);
  await f.cleanup();
  assert.equal(f.tracker.state.status, 'removed');
});

test('disconnection after receiving the key reconnects once solely for cleanup', async () => {
  const f = fixture();
  await f.tracker.insert(f.insert, f.requireOwner);
  f.setConnected(false);
  await f.cleanup();
  assert.deepEqual(f.counts(), { inserts: 1, reconnects: 1 });
  assert.equal(f.styles.has('owned-key'), false);
});

test('lost insertion response remains unknown and cannot trigger another insertion', async () => {
  const f = fixture();
  await assert.rejects(f.tracker.insert(async () => {
    await f.insert();
    throw new Error('Response lost');
  }, f.requireOwner), /Response lost/);
  assert.deepEqual(f.tracker.state, { status: 'application-unknown', key: null });
  assert.equal(await f.cleanup(), false);
  await assert.rejects(f.tracker.insert(f.insert, f.requireOwner), /Do not repeat/);
  assert.deepEqual(f.counts(), { inserts: 1, reconnects: 0 });
});

test('navigation blocks new insertion but does not block removal of the known key', async () => {
  const f = fixture();
  await f.tracker.insert(f.insert, f.requireOwner);
  f.setRoute('/another-route');
  await f.cleanup();
  assert.equal(f.styles.has('owned-key'), false);
});

test('changed process/endpoint owner refuses cleanup and reconnect, retaining pending key', async () => {
  const f = fixture();
  await f.tracker.insert(f.insert, f.requireOwner);
  f.setOwner('different');
  f.setConnected(false);
  await assert.rejects(f.cleanup(), /Owner changed/);
  assert.equal(f.tracker.state.key, 'owned-key');
  assert.equal(f.styles.has('owned-key'), true);
  assert.deepEqual(f.counts(), { inserts: 1, reconnects: 0 });
});

test('cleanup reconnect is bounded even if the replacement transport also fails', async () => {
  const f = fixture();
  await f.tracker.insert(f.insert, f.requireOwner);
  let removals = 0, reconnects = 0;
  await assert.rejects(f.tracker.remove({
    remove: async () => { removals++; throw new Error('Disconnected'); },
    checkAfter: f.requireOwner, disconnected: () => true,
    reconnect: async () => { reconnects++; }
  }), /Disconnected/);
  assert.equal(removals, 2);
  assert.equal(reconnects, 1);
  assert.equal(f.tracker.state.key, 'owned-key');
});

test('acknowledged removal remains removed when post-removal verification fails', async () => {
  const f = fixture();
  await f.tracker.insert(f.insert, f.requireOwner);
  await assert.rejects(f.tracker.remove({
    remove: async key => { f.styles.delete(key); },
    checkAfter: async () => { throw new Error('Owner check failed after removal'); },
    disconnected: () => true, reconnect: async () => assert.fail('Removal was already acknowledged')
  }), /Owner check failed after removal/);
  assert.deepEqual(f.tracker.state, { status: 'removed', key: null });
  assert.equal(f.styles.has('owned-key'), false);
});
