import test from 'node:test';
import assert from 'node:assert/strict';
import { restartAlertGeometry, selectRestartAlert, revalidateRestartAlert, pendingRestartPrompt } from '../scripts/lib/catalog-e2e-ui.mjs';

const profile = { name: 'Style Lab', bundleIdentifier: 'test.stylelab', bundlePath: '/Synthetic/Style Lab.app' };
const text = 'Style Lab is running without extensions.';
const informative = 'Style Lab will quit normally, then reopen with your enabled extensions.';
const snapshot = () => ({ ownerPID: 123, ownerBundleIdentifier: 'test.manager', windows: [{
  index: 1, title: '', role: 'AXWindow', subrole: 'AXDialog', complete: true, geometry: [-900, 50, 410, 280], texts: [text],
  buttons: [
    { name: 'Not Now', enabled: true, path: [2], geometry: [-875, 270, 120, 32] },
    { name: 'Restart', enabled: true, path: [3], geometry: [-650, 270, 120, 32] },
  ],
}] });

test('native alert accepts named buttons in either AX order and combined native text', () => {
  for (const combined of [false, true]) {
    for (const reverse of [false, true]) {
      const data = snapshot();
      if (combined) data.windows[0].texts = [`${text}\n${informative}`];
      if (reverse) data.windows[0].buttons.reverse();
      const result = selectRestartAlert(data, text);
      assert.equal(result.restart.name, 'Restart');
      assert.deepEqual(result.restart.path, [3]);
      assert.deepEqual(result.geometry, [-900, 50, 410, 280]);
    }
  }
  const titled = snapshot(); titled.windows[0].title = text; titled.windows[0].texts = [];
  assert.equal(selectRestartAlert(titled, text).promptText, text);
});

test('different, partial, already-running and incomplete alerts cannot match', () => {
  for (const wrongText of ['Other App is running without extensions.', `Prefix ${text}`, `${text} Unexpected suffix`, 'Restart Style Lab with extensions?', `${text} Other App will quit normally, then reopen with your enabled extensions.`]) {
    const data = snapshot(); data.windows[0].texts = [wrongText];
    assert.throws(() => selectRestartAlert(data, text), /exactly one/);
  }
  const incomplete = snapshot(); incomplete.windows[0].complete = false;
  assert.throws(() => selectRestartAlert(incomplete, text), /incomplete/);
  const duplicate = snapshot(); duplicate.windows.push(structuredClone(duplicate.windows[0]));
  assert.throws(() => selectRestartAlert(duplicate, text), /exactly one/);
  duplicate.windows[0].buttons = [];
  assert.throws(() => selectRestartAlert(duplicate, text), /exactly one/);
});

test('wrong, extra, duplicate, disabled and outside-window buttons fail closed', () => {
  const mutations = [
    w => { w.buttons[1].name = 'Continue'; },
    w => { w.buttons[0].name = 'Restart'; },
    w => { w.buttons.push(structuredClone(w.buttons[1])); },
    w => { w.buttons[1].enabled = false; },
    w => { w.buttons[1].geometry[0] = 900; },
    w => { w.buttons[1].path = w.buttons[0].path; },
  ];
  for (const mutate of mutations) {
    const data = snapshot(); mutate(data.windows[0]);
    assert.throws(() => selectRestartAlert(data, text));
  }
});

test('capture geometry permits variable native sizes and secondary screens within bounds', () => {
  assert.deepEqual(restartAlertGeometry([-2000.5, -300.25, 512.5, 350.5]), [-2001, -301, 513, 352]);
  for (const values of [[0, 0, 0, 250], [0, 0, -1, 250], [0, 0, NaN, 250], [0, Infinity, 410, 280], [0, 0, 9000, 280], [200000, 0, 410, 280], [0, 0, 4096, 4096], [0, 0, 410]]) {
    assert.throws(() => restartAlertGeometry(values));
  }
});

test('pre-click revalidation rejects manager, window, geometry or button changes', () => {
  const original = selectRestartAlert(snapshot(), text);
  assert.deepEqual(revalidateRestartAlert(original, structuredClone(original)), original);
  for (const mutate of [a => a.ownerPID++, a => a.windowIndex++, a => a.geometry[0]++, a => a.restart.path.push(1), a => { a.restart.name = 'Not Now'; }, a => { a.title = 'Different'; }]) {
    const changed = structuredClone(original); mutate(changed);
    assert.throws(() => revalidateRestartAlert(original, changed), /changed before click/);
  }
});

test('journal matching preserves exact app, PID, start time and pending presentation', () => {
  const presented = { appKey: profile.bundleIdentifier, bundlePath: profile.bundlePath, event: 'promptPresented', processIdentifier: 456, processStartedAt: 810000000, timestamp: 810000100 };
  assert.equal(pendingRestartPrompt([], profile, 456), null);
  assert.equal(pendingRestartPrompt([{ ...presented, appKey: 'other' }], profile, 456), null);
  assert.equal(pendingRestartPrompt([presented], profile, 456), presented);
  for (const change of [{ processIdentifier: 789 }, { processStartedAt: undefined }]) {
    assert.throws(() => pendingRestartPrompt([{ ...presented, ...change }], profile, 456), /expected process/);
  }
  assert.throws(() => pendingRestartPrompt([presented, { ...presented, timestamp: 810000101 }], profile, 456, presented), /instance changed/);
  assert.throws(() => pendingRestartPrompt([{ ...presented, processStartedAt: 810000001 }], profile, 456, presented), /instance changed/);
  for (const event of ['restartAccepted', 'restartDeclined']) {
    assert.throws(() => pendingRestartPrompt([presented, { ...presented, event, timestamp: 810000101 }], profile, 456, presented), /already been answered/);
  }
});
