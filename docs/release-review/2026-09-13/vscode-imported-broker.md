# VS Code imported CSS/JavaScript broker

Implementation candidate on 2026-09-13. No VS Code process was launched, attached to, stopped or modified by this subtask. This records source and temporary-model tests; live native/package proof remains separate.

## Curated transport and route

The existing runtime profile identifies `com.microsoft.VSCode`, `/Applications/Visual Studio Code.app`, its `Contents/MacOS/Code` executable and ordinary loopback TCP debugging. The raw profile has no extra flags; normalization adds `--remote-debugging-port=0` and `--remote-debugging-address=127.0.0.1`.

`supportsCatalogJavaScript` permits imported scripts only for that reviewed profile, including its name, anchored vscode-file route, Manage control, unique ordinary flags and absence of a local-service override. Drift and every other vendor profile retain CSS-only selection. `isCatalogJavaScriptPage` further restricts execution to `vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html`, allowing ordinary query/hash state. A read-only listing confirmed that resource exists in the installed app. The JS-only path uses the normal workspace and does not depend on login/onboarding controls.

The transport verifies its owned kernel process identity and exclusive loopback listener before every renderer operation. Controller `assertPage` also checks unique target selection and the current main-frame route. Only this profile receives `Runtime.enable`, `Runtime.evaluate`, `Runtime.compileScript`, `Page.createIsolatedWorld`, and the required console/exception/context/load/navigation events. CSP bypass, universal-access worlds and browser/main-process operations are refused. Normal operation collects no screenshots.

## Selection and lifecycle

`selectRendererExtensions` factors the fixture's bounded mixed selection; `selectCatalogExtensions`/`readCatalogExtensions` apply it to VS Code. Limits remain 64 enabled target records, unique UUID IDs, 32 files per record, contained filename labels of at most 256 UTF-8 bytes, consistent first-source fields, CSS at most 64 KiB including joins and JavaScript at most 256 KiB total. Names are labels, never paths to read. Existing CSS APIs remain available.

The broker creates `RendererScriptController` after ordinary target/ownership checks. CSS retains the Manage-control/readback checks. JS-only selection skips fixed-control lookup. CSS application precedes script synchronization; status records script states/revisions without source text.

Individual load/syntax failures are recoverable only when core states confirm complete cleanup. The broker publishes `phase: error`, keeps healthy independent extensions and the library watcher alive, and caches the failed revision to avoid retrying every 750 ms. Changed source or document reload can retry. Ownership/transport failure or uncertain cleanup remains fatal/unresolved. The fixture broker uses the same semantics. The native reviewer separately distinguishes connected script errors from a missing runtime for restart prompts.

Reapplication results publish through the broker loop. Final detach disposes JavaScript before CSS when the target is connected. Confirmed process exit is recorded separately from verified cleanup; a live disconnected app leaves removal unresolved. The broker never terminates vendor apps.

The neutral `ExtensionSessionLogFile` retains the fixture writer's private atomic storage, 500-event/512-KiB limits and monotonic sequences. Its envelope contains `schema: 1`, the profile app key, native output UUID (or generated UUID for older CLI folder layouts), attributed events and dropped-event count. It does not copy source or subscribe to the app-global console.

## Validation and live-proof limits

**62 relevant Node tests passed**, including eight new VS Code boundary cases, in [the test log](../../../output/release-review/2026-09-13/vscode-mixed-broker-unit-tests.log). They cover other vendor guards, profile/route drift, event scoping, method/CSP/universal-access refusal, owner failure before Runtime calls, JS-only control independence, healthy/failed siblings, unresolved cleanup and app-bound logs. These use fake transports and temporary files, not live vendor injection.

The subsequent **full Node suite passed 214 tests, zero failures/skips** after tightening recoverable-error classification to require at least one failed state and reject every reload-blocked state. [Full test log](../../../output/release-review/2026-09-13/vscode-mixed-full-node-tests.log)

This production broker uses the normal VS Code profile. Opening it can update preferences/state even if no project file is edited. Current production profiles do not accept arbitrary workspace or `--user-data-dir` overrides. A live E2E run promising no normal-profile changes therefore needs a separately reviewed owned temporary profile/test launch mode, or must explicitly acknowledge normal app-state writes. Do not silently broaden launch overrides or attach to the existing user editor.

Required live proof: normal empty workspace, user-imported CSS+JS, visible CSS change, injected button handler and attributed log, idempotence, reload, healthy source surviving a failed sibling, removal, unchanged strict signature/full bundle fingerprint, native log-sheet display and no repeated restart prompts for recoverable errors. The historical onboarding CSS-only result does not prove this new path.
