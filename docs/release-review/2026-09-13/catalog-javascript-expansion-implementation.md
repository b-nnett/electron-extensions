# Catalog JavaScript implementation and evidence

The existing 47 catalog profiles now opt into the shared imported CSS/JavaScript renderer engine. This is an implementation capability, **not a claim that 47 installed apps passed end-to-end testing**. No vendor app was launched during this subtask, and the canceled 50-app sweep was not resumed.

Every profile declares exactly:

```json
"rendererRuntime": {
  "engine": "isolated-js-v1",
  "verification": "not-verified"
}
```

The catalog contains seven TCP, two LaunchServices TCP and 38 pipe profiles. The edit added this field to existing entries; app identities, paths, executables, transport arguments, route patterns and controls were preserved. Live proof reports remain separate from the manifest. The existing native VSCode proof and partial Figma proof must retain their original scope and results.

## Runtime boundaries

- `lib/catalog-stylesheet.mjs:45` rejects unknown capability fields, engines and verification values. Missing capability retains legacy CSS-only selection. `supportsCatalogJavaScript` at line 110 first applies the existing complete profile validator, then checks the capability.
- VSCode and Figma keep their additional exact identity and document checks. Matching either their slug, bundle ID or bundle path triggers those restrictions, so changing a slug cannot turn one into a generic unrestricted profile. Figma remains login-only. `isCatalogJavaScriptPage` at line 133 accepts the verified local-service route binding for Antigravity and otherwise preserves the existing anchored app route.
- The broker still loads only its bundled catalog and accepts no arbitrary executable, target URL, selector or launch flags. Source records cannot select a different transport or give themselves capabilities. Selection is bound to the configured target bundle ID; unrelated and disabled source records remain inert.
- All admitted profiles reuse `selectRendererExtensions`, the shared controller and the existing mixed broker path: 64 enabled target records, 32 files each, UUID identities, safe relative source labels, matching legacy first-source fields, 64 KiB total CSS including joins, and 256 KiB total JavaScript. Empty selections disable the runtime; an enabled selection containing only whitespace is refused before launch.
- JavaScript still runs in a uniquely identified isolated renderer world. The runtime checks the selected main frame and current process/transport ownership, refuses ambiguous roots, keeps Node globals absent, and does not bypass CSP or grant universal access. The pipe grant remains limited to the selected attached session. Page reload is not a production capability.
- Normal mixed application uses stylesheet readback and script states instead of a vendor's diagnostic button. Recoverable per-extension errors retain independent healthy extensions and are retried only on changed selection or reload. Logs retain only bounded attributed extension events, not unrelated app console output, sources or screenshots.

Native policy/marker parity is owned by reviewer 03, rather than implemented again in this Node subtask. It binds the selected bundle ID to the signed helper capability. ChatGPT's separate adapter remains owned by the root task.

## Operations corrections included

`RendererScriptController.init()` no longer enables Runtime. Empty CSS-only lifecycle operations make no renderer JavaScript requests; first selected JavaScript enables Runtime and creates its guarded world lazily. A refused admission still fails explicitly when JavaScript is actually selected.

`scripts/dock-catalog-session.mjs:72` now rolls evidence to the latest 64 revisions instead of stopping an app after 64 edits. `revisionCount` remains monotonic, entries retain their unique `number`, and `droppedRevisions` states how much history was discarded. Current status revision and diagnostic filenames use the monotonic count. Explicit legacy screenshot diagnostics retain their separate collection limit.

`readBoundedJSON` at `lib/catalog-stylesheet.mjs:57` uses `O_NOFOLLOW | O_NONBLOCK` before validating the opened regular file. A FIFO cannot stall the broker waiting for a writer; symlink inputs are refused. Existing UTF-8 and size bounds remain.

Final catalog survival reporting now samples kernel identity **after** closing transport and finishing the integrity check. A child exit observed during the asynchronous sample overrides an old alive result; unknown identity remains unknown. The earlier Figma report's cached survival claim is corrected by the behavior documented in [pipe-close-behavior.md](pipe-close-behavior.md).

## Validation

| Evidence | Result | Limit |
| --- | --- | --- |
| `output/release-review/2026-09-13/generic-catalog-focused-tests.log` | 55 passed | Synthetic catalog, controller, ownership/route and operations tests |
| `output/release-review/2026-09-13/generic-catalog-full-node-tests.log` | 231 passed, zero failures or skips | Full Node suite at this handoff; no native build |
| `output/release-review/2026-09-13/imported-pipe-2aa30119-c9ee-40bf-bbbf-59327b96cb27/report.json` | Real owned Style Lab pipe proof passed | Shared renderer/transport proof, not a vendor or full native-product proof |

The owned run verifies imported CSS and JavaScript, idempotent initialization, attributed click output, independent healthy behavior during another extension's syntax failure, attributed uncaught handler errors, a fresh unique context and automatic reapplication after reload, disable/re-enable, registered cleanup, and capability revocation after detach. The fixed fixture's complete 265-file fingerprint and signature remain unchanged. Its temporary profile was removed after its exact process exited. No real library or Dock data was touched.

Remaining verification is app-specific: current version, current allowed route, normal workspace versus login screen, renderer admission, actual user interaction, reload, disable and cleanup. This implementation does not certify those results for the other catalog apps or widen their route coverage.
