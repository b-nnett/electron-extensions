# Release review 05: native UX and accessibility

Date: 2026-09-13. Reviewer: independent subagent `release_05_ux`.

Follow-up: capability presentation, authoring instructions and a native keyboard Dock alternative were subsequently implemented; draft persistence was added for updater relaunches. See `ux-fixes.md` and its passing focused test log. The findings below describe the initial review snapshot; the diagnostics and operation-error findings remain open, and live accessibility verification is still outstanding.

**Verdict: NO-GO for a general release with the current extension-creation and all-apps positioning.** A clearly labelled CSS preview for supported apps is much closer. The native navigation, app information, restart alerts and basic extension library flows are implemented, but users can still be led into unsupported work and the Dock fallback is inaccessible without pointer dragging.

Scope: read-only inspection of SwiftUI/AppKit source, launcher capability checks and relevant test inventory. No live app launch, target restart, Dock write, preference change, VoiceOver session or UI screenshot was performed by this reviewer. DMG packaging was excluded. Sparkle integration was being added concurrently by the root agent; its new controls are **not assessed here**, and updater absence in the initial snapshot is not counted as a finding.

## Findings

### 1. P1 — Advertised creation/import capabilities do not match execution capabilities

- `macos/Sources/CreateExtensionView.swift:102` describes stylesheets or scripts; line 113 explicitly tells users to list either or both CSS and JS.
- `macos/Sources/AppExtensionsView.swift:29` and line 55 expose the same Add Extension entry points for every discovered app. Connection/capability text is hidden until an extension already exists (line 37).
- `macos/Sources/ElectronLauncher.swift:71` validates **all configured runtime profiles as CSS-only**; enabled JS/mixed packages are rejected at lines 76 and 79. `ExtensionManager.swift:56` imports packages enabled, and line 157 calls this preparation before saving.
- Unconfigured apps instead take the ordinary-alias path at `ElectronLauncher.swift:349`; an imported extension can therefore appear Enabled and move into Your Apps while its code is not run. The saved-only explanation exists at line 660, but arrives after import.

Impact: a new user can spend time creating a script, or targeting an app with no adapter, following the app's own instructions and only discover the limitation at import or afterwards. This is particularly material for a release of an extension app: the primary task must state the capabilities it can fulfil.

Before release: show the selected app's supported source types and runtime availability before creation/import. Either expose a plainly labelled storage-only mode for unsupported cases or prevent them from appearing as runnable extensions. Keep the displayed Enabled state separate from the actual runtime state. These are capability presentation requirements; they do not require adding unsupported execution paths.

### 2. P2 — Copied authoring instructions contain stale and contradictory limits

`macos/Sources/CreateExtensionView.swift:51` describes source files up to 2 MiB and total source up to 8 MiB, while line 56 mentions a 64 KiB runtime limit only in text saying the current Dock runtime supports Style Lab and experimental ChatGPT. The implementation now includes catalog profiles (`ElectronLauncher.swift:62`), and its 64 KiB aggregate enabled-CSS limit applies to every profile (`ElectronLauncher.swift:71`). The visible authoring page does not explain these execution limits.

Impact: the prompt sent to an agent misstates current coverage and encourages packages that can be structurally valid but cannot be enabled. It also treats the limit as a package-writing concern although it is shared by all enabled extensions for the target app.

Before release: derive selected-app instructions from the same capability model used at import/launch, and distinguish accepted package size from aggregate executable CSS size. Test that the text agrees with the actual capability model rather than asserting a historical two-app statement.

### 3. P2 — Manual Dock installation has no accessible or keyboard equivalent

`macos/Sources/DockInstallWindow.swift:261` exposes the custom icon as an accessibility image. `DockIconDragView` handles `mouseDown`/`mouseDragged` only (lines 281–291); it supplies no accessibility action, focusable keyboard action or accessible drag implementation. When automatic Dock installation fails, `ExtensionManager.swift:124` falls back to this panel.

Impact: the recovery path requires a pointer drag. A descriptive accessibility label does not make that operation executable by keyboard or assistive technology.

Before release: provide a focusable alternative appropriate to the failure, such as revealing the verified shortcut in Finder together with native keyboard-accessible instructions, and implement/verify an assistive-technology action if retaining the custom drag control. Test the failure/recovery path with VoiceOver and keyboard navigation. The close button itself is labelled and Escape is handled.

### 4. P2 — Extension details cannot show the runtime diagnostics requested by the product

`macos/Sources/ExtensionDetailsSheet.swift:14` reads only library management events. The Logs section and Copy Logs action use this array (lines 53–78 and 109–113). Its explanatory text at line 57 correctly distinguishes library activity, but offers no link to runtime diagnostics. The app-page More menu merely opens the session directory in Finder (`AppExtensionsView.swift:114`).

Impact: when a stylesheet fails to apply, the prominent per-extension Logs view and copied report contain add/enable/remove activity rather than the connection or application failure. Users must leave the app and choose among raw session files to debug the main feature. This is a functional completion gap against the requested extension-details debugging flow, not a claim that runtime logs are absent.

Before release: surface connection/application outcomes in the details view, associate what can be associated with the selected extension, and add an explicit runtime-log action. Do not label unrelated session diagnostics as per-extension console logs.

### 5. P3 — Operation errors share an unrelated title and Dock fallback opens alongside an error alert

Every `ExtensionManager.errorMessage` is presented under “Couldn't update extensions” (`macos/Sources/ExtensionsAnywhereApp.swift:156`), including Open App failures (`ExtensionManager.swift:85`) and Dock installation failures (line 124). On a Dock failure the same path sets this alert message and immediately presents the floating fallback panel (lines 125–126).

Impact: the alert describes the wrong operation and can compete with the recovery UI. The code establishes both presentations; their exact visual/modality interaction was not reproduced in this read-only review.

Recommended fix: use operation-specific error state and show the recoverable Dock explanation within the panel, reserving a native alert for an unrecoverable failure.

## Positive findings

- The principal window uses native `NavigationSplitView`, sidebar List, ToolbarItems, Settings scene and MenuBarExtra rather than rebuilding these controls.
- The two requested sidebar sections and app icons are implemented; decorative row icons are accessibility-hidden. A persistent Create Extension button and Command-S sidebar command exist.
- The native `NSAlert` factory provides Restart and Not Now with Return/Escape equivalents (`macos/Shared/NativeRestartAlert.swift:8`). The monitor dismisses stale prompts when the app reconnects, exits or the setting changes (`ExtensionRuntimeMonitor.swift:200`).
- Import uses the system file importer, previews manifest metadata, has default/cancel keyboard actions, and preserves errors in the sheet (`AppExtensionsView.swift:203`).
- Removal asks for confirmation and explains that original source files remain; library write errors preserve the sheet. Extension enable toggles have meaningful accessibility labels.
- App Information distinguishes filesystem date-added data from installation history (`AppInformationView.swift:129`) and supports copying metadata and revealing the original app in Finder.
- The Dock panel is compact, positioned by screen/Dock geometry, has a labelled close button and Escape support, and restores its visibility lease on close. Success checks actual shortcut pin changes, rather than mistaking arbitrary Dock size changes for installation.
- App discovery and coding-tool scanning use detached tasks; stale app selections are cleared after refresh.

## Evidence limits / release acceptance

Source inspection cannot establish VoiceOver focus order, contrast in light/dark and increased-contrast modes, minimum-window layout, menu keyboard navigation, or multi-display Dock placement. Relevant policy/manifest/manager tests exist, but the inspected test inventory has no dedicated accessibility UI suite. No tests were run by this reviewer, avoiding interference with the root agent's concurrent build. Existing screenshots and prior live verification should be retained as historical evidence, not labelled a fresh accessibility test.

The release gate from this review is: truthful selected-app capabilities before users author/import; instructions consistent with those capabilities; usable recovery when automatic Dock installation fails; and a focused manual keyboard/VoiceOver pass of import, enable/disable, restart prompt, details and Dock fallback. Runtime-diagnostic integration should be completed or explicitly scoped as a preview limitation.
