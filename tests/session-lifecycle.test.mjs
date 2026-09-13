import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLifecycle } from '../lib/session-lifecycle.mjs';
import { CosmeticTrial } from '../lib/cosmetic-trial.mjs';

// Synthetic owned page: exercise the real stylesheet apply/remove path without
// launching any app. Ownership is checked separately from interruption state.
async function fixture() {
  const state = { owned: true, closed: false, inputClosed: false, sheet: '', events: [] };
  const lifecycle = new SessionLifecycle({
    closeInput: () => { state.inputClosed = true; },
    closeTransport: () => { state.closed = true; },
    record: (event, details) => state.events.push({ event, ...details })
  });
  const page = { async call(method, params = {}) {
    lifecycle.check();
    if (!state.owned) throw new Error('Owned process identity no longer matches.');
    if (state.closed) throw new Error('Transport closed before stylesheet cleanup.');
    switch (method) {
      case 'Page.enable': case 'DOM.enable': case 'CSS.enable': return {};
      case 'DOM.getDocument': return { root: { nodeId: 1 } };
      case 'DOM.querySelectorAll': return { nodeIds: [2] };
      case 'DOM.getBoxModel': return { model: { width: 120, height: 30 } };
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'fixture' } } };
      case 'CSS.createStyleSheet': return { styleSheetId: 'owned-sheet' };
      case 'CSS.setStyleSheetText':
        assert.equal(params.styleSheetId, 'owned-sheet');
        state.sheet = params.text;
        state.events.push({ event: params.text ? 'css-applied' : 'css-cleared' });
        return {};
      case 'CSS.getComputedStyleForNode': return { computedStyle: [
        { name: 'background-color', value: state.sheet ? 'rgb(22, 163, 74)' : 'rgb(30, 30, 30)' },
        { name: 'color', value: state.sheet ? 'rgb(255, 255, 255)' : 'rgb(200, 200, 200)' },
        { name: 'background-image', value: 'none' }
      ] };
      default: throw new Error(`Unexpected fixture method: ${method}`);
    }
  } };
  const trial = new CosmeticTrial(page, 'button#fixture');
  await trial.init();
  assert.equal((await trial.apply()).matchesExpected, true);
  return { state, lifecycle, trial };
}

test('signal blocks new work but permits real CSS restoration before transport closure', async () => {
  const { state, lifecycle, trial } = await fixture();
  lifecycle.interrupt('SIGTERM');
  assert.equal(state.inputClosed, true);
  assert.equal(state.closed, false);
  await assert.rejects(trial.inspect(), /Session interrupted/);
  assert.equal(lifecycle.beginCleanup(), true);
  assert.equal((await trial.remove()).matchesOriginal, true);
  await trial.dispose();
  lifecycle.closeTransport();
  assert.equal(state.sheet, '');
  assert.ok(state.events.findIndex(e => e.event === 'css-cleared') < state.events.findIndex(e => e.event === 'transport-close'));
  assert.equal(lifecycle.interrupted, true); // Preserve the conservative verdict.
});

test('signal during cleanup retains transport without bypassing the owned-process check', async () => {
  const { state, lifecycle, trial } = await fixture();
  lifecycle.beginCleanup();
  lifecycle.interrupt('SIGINT');
  assert.equal(state.closed, false);
  assert.equal(state.events.find(e => e.event === 'signal-received').phase, 'cleanup');
  state.owned = false;
  await assert.rejects(trial.remove(), /Owned process identity/);
  assert.notEqual(state.sheet, '');
  state.owned = true;
  assert.equal((await trial.remove()).matchesOriginal, true);
  await trial.dispose();
  lifecycle.closeTransport();
  assert.equal(lifecycle.beginCleanup(), false);
  assert.equal(state.closed, true);
});
