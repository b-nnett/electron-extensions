# Release review 01 — product scope and verified coverage

**Verdict: NO-GO for a general release of the requested app.** The native interface and CSS proof are substantial, but the implemented product is still a set of restricted CSS trials. The original promise includes custom CSS and JavaScript across Electron apps, with normal launching and recovery. That promise is not met. A separately scoped experimental CSS preview would need explicit supported-app/surface limits before distribution.

Review performed 13 September 2026 against the working tree and saved evidence. This is a read-only product/code/evidence review: no apps were launched, restarted, installed, or modified. One pure Node route-matcher check was run, described below. Sparkle/auto-update work is proceeding separately and is not assessed by this review. DMG and installer presentation are excluded.

## Ranked findings

### 1. P1 — Production CSS execution still requires proof-screen controls and routes

The shipped manifest restricts Slack to its first sign-in page, Notion to its login route, and Figma to its login route. Postman requires its account-offer modal close button, while Obsidian requires its vault setup control. These are not just E2E-test selectors: the real broker uses the same manifest and requires that control before writing **any** nonempty imported CSS.

Evidence:

- [compatibility/runtime-profiles.json:11](../../../compatibility/runtime-profiles.json#L11), [line 37](../../../compatibility/runtime-profiles.json#L37), [line 115](../../../compatibility/runtime-profiles.json#L115): login-only URL rules.
- [compatibility/runtime-profiles.json:64](../../../compatibility/runtime-profiles.json#L64) and [line 77](../../../compatibility/runtime-profiles.json#L77): transient modal/setup controls.
- [lib/catalog-stylesheet.mjs:168](../../../lib/catalog-stylesheet.mjs#L168): `control()` requires exactly one match for the catalog selector. [Line 229](../../../lib/catalog-stylesheet.mjs#L229): every nonempty stylesheet update invokes that check.
- [scripts/dock-catalog-session.mjs:377](../../../scripts/dock-catalog-session.mjs#L377) and [line 422](../../../scripts/dock-catalog-session.mjs#L422): the actual production broker selects and continuously revalidates this fixed route.

Reproducible consequence: start Figma already signed in to a design, or close Postman's account-offer modal before applying a general theme. The manifest no longer provides a qualifying renderer/control, so arbitrary valid CSS cannot connect. This conclusion follows from code; those user interactions were not performed during this review.

The pure matcher check called `isCatalogAppPage` with the committed profile definitions. It returned `true` for Figma `/login`, Notion `/login`, and Slack `/ssb/first`, but `false` for illustrative non-login routes `/design/example/Design`, `/example-page`, and `/client/T_EXAMPLE/C_EXAMPLE`, respectively. This verifies the route restriction, not the current URLs of actual signed-in vendor apps.

Release requirement: distinguish supported launch/runtime identities from one-off visual test controls, then verify intended everyday surfaces through supported app mechanisms. Until then, expose the precise supported screen in the product and do not present a profile as general app support. Preserve identity and ownership checks.

### 2. P1 — Imported JavaScript cannot run in any configured product profile

All configured profiles run `ElectronLaunchProfile.validate`, which rejects enabled JS and mixed CSS/JS packages. New imports are enabled by default, so importing a JavaScript package for a configured app fails before it is saved. Unconfigured apps can store it but cannot execute it. The fixed fixture button demonstration is a different controller and is not imported-package execution.

Evidence:

- [macos/Sources/ElectronLauncher.swift:71](../../../macos/Sources/ElectronLauncher.swift#L71): CSS-only validation, including every packaged source; [line 355](../../../macos/Sources/ElectronLauncher.swift#L355): applied to every configured runtime profile.
- [macos/Sources/ExtensionManager.swift:56](../../../macos/Sources/ExtensionManager.swift#L56): imports default enabled; [line 156](../../../macos/Sources/ExtensionManager.swift#L156): preparation must succeed before persistence.
- [lib/catalog-stylesheet.mjs:76](../../../lib/catalog-stylesheet.mjs#L76): CSS-only validation is also enforced by the production broker.
- [docs/EXTENSION-FORMAT.md:54](../../../docs/EXTENSION-FORMAT.md#L54): explicit absence of imported JS execution and console collection.

Reproduction by code path: select a configured app, choose a valid manifest with `js: ["main.js"]`, and press Add Extension. The `sourceType` or mixed-file guard throws “This launch profile supports CSS extensions only.” No app action is needed to establish the branch.

Release requirement: either formally scope the first release to CSS and make authoring/import UI consistently reflect that, or provide and verify the requested JS runtime/lifecycle before claiming script support. Chrome extension API compatibility is also not implemented and is correctly disclaimed in the format document.

### 3. P1 — Essential requested apps lack a product launch route, and users learn this too late

The runtime manifest contains 47 ordinary catalog profiles. Adding ChatGPT gives 48 of the 50 target vendor apps; Style Lab is an extra control. **Claude and Evernote are not in the product runtime catalog.** Claude's saved success is a manual supported-debugger CSS exercise, not a manager/Dock launch or unattended restart path. Evernote's ordinary launch route explicitly failed. These historical outcomes must not be called current native product support.

Evidence:

- [macos/Sources/ElectronLauncher.swift:59](../../../macos/Sources/ElectronLauncher.swift#L59): support is exactly Style Lab, ChatGPT, or a matching manifest entry.
- [macos/Sources/ElectronLauncher.swift:349](../../../macos/Sources/ElectronLauncher.swift#L349): without a profile, preparation creates an ordinary alias and executes no stored source.
- [output/e2e-50/2026-09-08/CURRENT-FINDINGS.md:42](../../../output/e2e-50/2026-09-08/CURRENT-FINDINGS.md#L42): Claude manual-only limitations; [line 47](../../../output/e2e-50/2026-09-08/CURRENT-FINDINGS.md#L47): Evernote unsupported route.
- [macos/Sources/AppExtensionsView.swift:29](../../../macos/Sources/AppExtensionsView.swift#L29): Add Extension is available regardless of runtime capability. The status explaining nonexecution is rendered only once records exist at [line 37](../../../macos/Sources/AppExtensionsView.swift#L37). New enabled records also move the app into the tweaked-app workflow.

Release requirement: since the user identified Claude as essential, its absent supported product path is a release blocker unless the product scope is deliberately changed. For unsupported apps, communicate capability before authoring/import and distinguish saved packages from usable tweaks. Do not weaken vendor protections to manufacture coverage.

### 4. P1 — The requested 50-app release evidence is incomplete

The authoritative ledger was last updated 8 September, with two full current native E2E passes (Figma and Bruno). The readable checkpoint distinguishes 24 additional CSS/image proofs, 21 other failed current trials, one manual-only Claude proof, one unsupported Evernote route, and a pending native ChatGPT trial. Only 23 background flows retain cleanup acceptance; Rancher has a Dock receipt conflict. This does not establish a release across the requested 50 apps.

Evidence:

- [output/e2e-50/2026-09-08/CURRENT-FINDINGS.md:3](../../../output/e2e-50/2026-09-08/CURRENT-FINDINGS.md#L3) and [line 5](../../../output/e2e-50/2026-09-08/CURRENT-FINDINGS.md#L5): explicit incomplete checkpoint and disjoint counts.
- [docs/E2E-50-2026-09-08.md:15](../../../docs/E2E-50-2026-09-08.md#L15): full-flow acceptance requires native launch, CSS/readback, visible effect, disable/restore, actual prompt and restart, new healthy identity, actual menu launch, unchanged signatures, and cleanup.
- [output/e2e-50/2026-09-08/CURRENT-FINDINGS.md:70](../../../output/e2e-50/2026-09-08/CURRENT-FINDINGS.md#L70): the over-five-app menu branch lacks recorded actual UI proof.
- [docs/NATIVE-RESTART-ALERTS.md:26](../../../docs/NATIVE-RESTART-ALERTS.md#L26) and [docs/RESTART-AND-APPEARANCE-REGRESSIONS.md:29](../../../docs/RESTART-AND-APPEARANCE-REGRESSIONS.md#L29): later successful fixture restart and ChatGPT cancellation/retained-session checks explicitly do not complete the 50-app work or establish a ChatGPT restart.

The machine ledger uses separate native and background status fields. Its `counts` say `passed: 2`, `pending: 44`, `failed: 2`, `blocked: 2`; those are not interchangeable with the checkpoint's combined outcome groups. Historical 44/49 CSS compatibility must also remain separate from this current native acceptance count.

Release requirement: agree the release support list and complete its real product flows on the release build, including signed-in navigation, multiple windows where supported, normal relaunch, and cleanup. Record remaining apps as unsupported/experimental. An actual vendor update is still untested; the normal-relaunch simulation does not prove updater behavior.

### 5. P2 — Authoring instructions and core docs contradict current code

The in-app copy tells coding agents that only Style Lab and experimental ChatGPT have runtime profiles, although the application now loads 47 ordinary catalog profiles. The same obsolete statement appears in the main README, extension-format document, and native development docs. Conversely, the authoring flow invites plain browser JS even though configured-app imports reject it, and supported-screen limitations are not communicated before users create packages.

Evidence:

- [macos/Sources/CreateExtensionView.swift:53](../../../macos/Sources/CreateExtensionView.swift#L53) through its capability statement at [line 56](../../../macos/Sources/CreateExtensionView.swift#L56).
- [docs/EXTENSION-FORMAT.md:3](../../../docs/EXTENSION-FORMAT.md#L3), [README.md:9](../../../README.md#L9), and [macos/README.md:42](../../../macos/README.md#L42).
- The true profile source is [macos/Sources/ElectronLauncher.swift:62](../../../macos/Sources/ElectronLauncher.swift#L62).

Release requirement: derive selected-app capability text from a common support model. Document CSS-only execution, exact tested surface/version, unverified lifecycle behavior, source-copy semantics, and missing asset/package updates consistently. Current activity logs are honestly labeled library activity rather than JS execution logs; retain that distinction.

## What the evidence does support

- JSON package import has bounded source files, path validation, copied storage, and persistent enabled settings; its format and runtime limits are documented separately.
- Exact app identity controls and runtime readback are present; target bundles are not intentionally patched or re-signed by this product flow.
- Real CSS effects, removal, and intact signing have been observed for many recorded app versions. The historical work is useful compatibility research, not sufficient native release acceptance.
- Native restart alerts and the latest appearance/helper-refresh fixes have meaningful controlled-fixture evidence. Their scope is explicitly documented.
- An experimental CSS release could be viable with a narrower declared supported list and verified ordinary usage screens. This review does not certify that narrower release: the list and acceptance run do not yet exist.

## Review validation

Read current SwiftUI import/status/profile code, native launcher capability selection, production CSS broker and stylesheet validation, authoring prompt, format docs, current 50-app findings/ledger, and 13 September alert/regression notes. Counted the committed runtime manifest (47 entries; no Claude/Evernote) and ran the pure route matcher for the six illustrative URLs above. No full test suite or live product trial was run by this reviewer, and no new compatibility success is claimed.
