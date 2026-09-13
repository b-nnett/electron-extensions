# Rapid disable → re-enable reconciliation

Candidate12's supervised Claude test exposed a real broker race. The script was disposed and its CSS removed, making the disabled state observable. The user/test re-enabled immediately, before the broker's asynchronous integrity check completed. The broker correctly refused to acknowledge the now-obsolete disabled library snapshot, but retained the previously confirmed **enabled** revision in its skip cache. The next poll saw that same enabled revision and skipped reconciliation, leaving the renderer disabled.

The native test's cadence and assertions remain unchanged. The correction invalidates the cached applied revision **before the first mutation**, and records a new confirmed revision only after successful document/library verification. An abandoned or superseded mutation can no longer make an old enabled cache entry describe a disabled renderer.

| Broker | Finding and correction |
| --- | --- |
| Claude | Same observed race. `scripts/dock-claude-session.mjs:169` calls the shared mixed apply helper with synchronous cache invalidation. |
| Catalog mixed CSS+JS | Identical race by source inspection. `scripts/dock-catalog-session.mjs:49` invalidates before stylesheet/script changes; the production call at line353 binds its actual `lastRevision`. |
| ChatGPT mixed CSS+JS | Identical race by source inspection. `lib/chatgpt-extensions.mjs:55` invalidates before changes; `scripts/dock-chatgpt-session.mjs:193` binds the actual cache. |
| Catalog CSS-only | Existing removal already clears `lastRevision` (`scripts/dock-catalog-session.mjs:335`). No identical stale enabled-cache skip remains after removal. |
| Owned fixture | Its existing loop commits the selection it actually applied (`scripts/dock-fixture-session.mjs:289`), so a newer re-enable differs on the next poll. It has no equivalent post-apply library-mismatch early return retaining an older enabled key. No change needed for this race. |

`tests/rapid-extension-toggle.test.mjs` exercises the actual catalog/Claude and ChatGPT apply functions with the real registered-disposal runtime. A promise barrier suspends the verification step after CSS and the authored resource disappear; the simulated library immediately returns to its original enabled snapshot. The test verifies that the disabled pass is unconfirmed, the cache remains invalid, the next pass restores one resource and its CSS, and subsequent unchanged polling remains idempotent. This uses no application launch, real library, or timing sleeps.

The [full Node suite](../../../output/release-review/2026-09-13/rapid-toggle-full-node-tests.log) passed **256/256 tests**, with no failures or skips. The fixed owned main-inspector transport proof remains valid for its recorded sequential lifecycle; it did not exercise this specific overlapping verification window. Candidate13's native Claude rerun is the final real-product validation of this correction.

Candidate12 remains immutable at `output/release-review/2026-09-13/notarization/build-12/Extensions Anywhere.app`, with Apple Accepted submission `b8505aac-cc29-4b64-9547-ce2dab3efa15`, stapled ticket, Gatekeeper acceptance and retained hash receipts. Its acceptance establishes authenticity of that earlier artifact, not correctness of this subsequently discovered race. Nothing was published by this workstream.
