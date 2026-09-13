# VS Code mixed runtime implementation handoff

Source/tests stable for the coordinating root's build 6. **Full `npm test`: 214 passed, zero failures/skips.** Evidence: [full log](../../../output/release-review/2026-09-13/vscode-mixed-full-node-tests.log). No live app launch/attachment or Swift build was performed by this subtask.

## Files and APIs

- `lib/dock-library.mjs`: `selectRendererExtensions(library, {appKey, name, recordLabel?})`; fixture `selectFixtureExtensions` delegates to it. Original fixture/ChatGPT CSS APIs remain unchanged. Mixed return shape adds `hasContent`, `jsBytes`, `jsExtensions: [{extensionID, revision, files: [{fileName, text}]}]` to existing CSS metadata. JS revisions hash ordered filename/source bytes.
- `lib/catalog-stylesheet.mjs`: `supportsCatalogJavaScript(profile)`, `isCatalogJavaScriptPage(url, profile)`, `selectCatalogExtensions` and `readCatalogExtensions`. Only the exact curated VS Code TCP profile qualifies; every other profile retains CSS-only behavior. Existing stylesheet ownership, route, control and readback checks remain.
- **New bundle dependency** `lib/extension-session-logs.mjs`: `ExtensionSessionLogFile(file, sessionID, {appKey, writer?})`, `rendererStateProof(states)`, `recoverableExtensionFailure(error)`. Fixture `FixtureExtensionLogFile` is a compatibility wrapper that pins its app key. Include this file and root's `renderer-script-controller.mjs` in the packaged Runtime.
- `scripts/dock-catalog-session.mjs`: `catalogRendererPage` wraps the verified page transport; `applyCatalogSources` applies CSS then synchronizes JS. Mixed product flow uses the shared controller and keeps all status publishing on the broker loop. JS-only source does not wait for the Manage control; CSS still does.
- `scripts/dock-fixture-session.mjs`: neutral log-writer extraction plus recoverable failure handling. Existing fixture selector/log/state helper APIs remain available.
- Tests: new `tests/catalog-extensions.test.mjs`, existing `tests/dock-fixture-extensions.test.mjs` and legacy catalog/fixture tests all pass.

## Security and status contract

Catalog JS is pinned to `com.microsoft.VSCode`, `/Applications/Visual Studio Code.app/Contents/MacOS/Code`, ordinary TCP flags, the reviewed profile name/route/Manage selector and no local-service override. Execution further requires the exact normal `vscode-file://vscode-app/.../electron-browser/workbench/workbench.html` document. `assertPage` checks current process/listener ownership, unique target identity and current main-frame route before controller operations. No new target, endpoint or launch-argument CLI override was added.

Only the JS profile receives Runtime enable/evaluate/compileScript, isolated-world creation, and console/exception/context-created/context-destroyed/context-cleared/load events. Navigation forwarding remains available to CSS as before. CSP bypass, universal access and browser/main-process calls are refused. Normal catalog screenshots remain off; explicit diagnostics retain their existing limits.

Recoverable errors require at least one failed state; every state must be active or failed with completed cleanup, and none may be reload-blocked. Such results publish live `phase: error` plus `jsStates`, retain healthy siblings and the library watcher, and cache the failed revision so polling does not retry it. Changed source or document reload can retry. Root/03's native status code uses these same bounded states to suppress inappropriate restart prompts without calling the result healthy. Terminal catalog status sets `pid: null`; cleanup/transport/ownership uncertainty remains fatal or unresolved.

Logs are `{schema:1, appKey, sessionID, droppedEvents, events}` with monotonic sequences, 500 events/512 KiB, 4096-byte messages, private atomic writes and attributed extension content only. Native session directories supply their UUID; old standalone CLI layouts receive a generated UUID. Reports contain state/file/revision metadata and byte counts, not source. Reapplication refreshes latest state proof; final JavaScript cleanup precedes CSS removal where the same target remains connected.

## Limits and next proof

The script source limits match native policy: 64 enabled records, UUID IDs, 32 files each, 256-byte relative filename labels, consistent package/legacy first source, CSS 64 KiB including joins and JS 256 KiB. No source filename is read as a path.

Root owns the next signed build and native/package E2E. The fixture's imported path was independently exercised by root/05, but this subtask has not exercised a live vendor. The normal VS Code launch can write its ordinary preferences/state. A promise of zero normal-profile writes needs a separately reviewed owned temporary test launch mode; the current production profile intentionally accepts only its debugger flags. The earlier Obsidian vault-plugin proposal was declined and was not implemented.

See [implementation and live-proof requirements](vscode-imported-broker.md) for remaining acceptance checks.
