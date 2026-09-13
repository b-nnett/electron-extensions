import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCatalogSources } from '../scripts/dock-catalog-session.mjs';
import { applyChatGPTSources, confirmChatGPTApplication } from '../lib/chatgpt-extensions.mjs';
import { FixtureExtensionRuntime } from '../lib/fixture-extension-runtime.mjs';

// Real broker mixed-apply routines and real registered script disposal, with an
// explicit barrier representing the asynchronous signature/library verification.
// No app, user library, or timing sleeps are involved.
for (const [name, apply] of [['catalog and Claude', applyCatalogSources], ['ChatGPT', applyChatGPTSources]]) {
  test(`${name}: immediate re-enable after cleanup cannot reuse the stale enabled revision`, async t => {
    const runtime = new FixtureExtensionRuntime(); t.after(() => runtime.dispose());
    let buttonCount = 0, initializes = 0, removals = 0;
    const record = { extensionID: '12345678-1234-5678-1234-567812345678', revision: 'source-1', files: [{ fileName: 'button.js', execute: ea => {
      buttonCount++; initializes++; ea.onDispose(() => { buttonCount--; removals++; });
    } }] };
    const on = { revisionKey: 'enabled-source-1', hasContent: true, hasCSS: true, css: 'button{outline:3px solid green}', jsExtensions: [record] };
    const off = { revisionKey: 'disabled', hasContent: false, hasCSS: false, css: '', jsExtensions: [] };
    const styles = { css: '', generation: 1, needsUpdate: false, async set(css) { this.css = css; return { generation: this.generation, stylesheetReadbackVerified: true }; } };
    const scripts = { async sync(records) {
      if (!records.length) { const state = await runtime.disable(record.extensionID); return state ? [state] : []; }
      return [await runtime.enable(records[0])];
    } };
    let library = on, lastRevision, releaseVerification;
    const verification = new Promise(resolve => { releaseVerification = resolve; });
    let announceMutation;
    const mutationVisible = new Promise(resolve => { announceMutation = resolve; });
    async function poll(selection, pauseVerification = false) {
      if (lastRevision === selection.revisionKey && !styles.needsUpdate) return 'skipped';
      const result = await apply(styles, scripts, selection, () => { lastRevision = undefined; });
      if (pauseVerification) { announceMutation(); await verification; }
      if (!await confirmChatGPTApplication({ selection, styles, generation: result.generation, readSelection: async () => library, stopped: () => false })) return 'unconfirmed';
      lastRevision = selection.revisionKey; return result.phase;
    }
    assert.equal(await poll(on), 'active'); assert.equal(buttonCount, 1);
    library = off; const disabling = poll(off, true);
    await mutationVisible;
    assert.equal(buttonCount, 0); assert.equal(styles.css, '');
    // This is the observed native test/user action: click Enable immediately
    // after the DOM shows removal, before the broker's integrity read finishes.
    library = on; releaseVerification(); assert.equal(await disabling, 'unconfirmed');
    assert.equal(lastRevision, undefined);
    assert.equal(await poll(library), 'active');
    assert.equal(buttonCount, 1); assert.equal(styles.css, on.css);
    assert.equal(initializes, 2); assert.equal(removals, 1);
    assert.equal(await poll(library), 'skipped'); assert.equal(initializes, 2);
  });
}
