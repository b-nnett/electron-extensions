# Active helper compatibility when enabling JavaScript

The build 7 source adds a capability guard before a new manager saves enabled JavaScript into a library watched by an older active helper. This work did not launch any app, modify an installed helper, or touch the user's library.

## Confirmed failure before the guard

`ExtensionManager.change` stages a candidate, calls `ElectronLauncher.prepare`, then saves the shared library. Preparation validates source against the new manager's capabilities, but intentionally preserves an active helper. Previously that preservation checked identity, signing, paths and the alias, without checking whether the old runtime understood JavaScript.

The archived notarized build 3 proves the consequence at source level. Its `Runtime/lib/catalog-stylesheet.mjs` rejects enabled JavaScript or mixed packages. Its `Runtime/scripts/dock-catalog-session.mjs` rereads the library every 750 ms; that error escapes the loop, removes its existing stylesheet during cleanup, and leaves the vendor app running without the broker. The old Style Lab broker similarly rejects JavaScript and stops its owned fixture during failure cleanup. Build 4 was not independently inspected for this review.

## Implemented behavior

- `RuntimeHelperCapabilities.swift` recognizes a strict protocol version and exact profile in the helper's signed Info.plist. The supported profiles are `stylelab`, `vscode`, and the later `figma` login-page adapter. Missing, malformed, future-version and foreign-profile metadata do not imply JavaScript capability.
- `ElectronLauncher.buildHelper` writes `EARendererJavaScriptProtocolVersion` and `EARendererJavaScriptProfile` before signing eligible generated helpers. `helperIsCurrent` requires those markers for JS-capable profiles, even when its existing source and runtime digests match, so a stopped unmarked helper is rebuilt.
- After the existing signature/configuration/alias checks, `ActiveLauncherPreparation` rejects a proposed enabled JS selection if an active or deferred helper lacks the capability. The error occurs before `ExtensionManager.change` saves; the current shared library, helper and CSS session remain unchanged. CSS-only and disabled-JS selections can still use the preserved helper.
- UI imports and enable toggles catch this typed compatibility error and offer a standard AppKit Restart / Not Now alert. The imported package or toggle intent stays in memory. Not Now leaves the library and existing session unchanged; an import sheet remains open.
- `RuntimeUpgradeCoordinator` uses the existing `AppRestartService` identity checks, normal termination, and shared 30-second timeout. It requires the exact target PID, start time, bundle identifier and installation path, waits for that target and its verified helper to exit, prepares the new compatible helper, retries the captured change once, then opens the app. Refused quit, cancellation, identity changes, preparation failure or retry failure never force termination or automatically repeat the prompt.
- Restart preparation is read-only before quit. It validates the real current source selection against the new profile and verifies the packaged runtime, old helper signature, configuration and alias. Its old-helper inspection temporarily disables JS records in memory. This covers unmarked intermediate helpers that already have saved JavaScript, without persisting the filtered selection, opening an ordinary alias, or changing Dock preferences. Only after shutdown does ordinary preparation rebuild the helper using actual saved records.
- Bounded reads compare the exact original library bytes after the alert, before and after preflight, after shutdown, after rebuilding, and inside the final staged mutation. An intervening library edit aborts the requested change; its newer bytes are preserved. The source/package itself is captured before waiting, so the retry does not reload a changed manifest file.
- Synchronous manager import APIs remain noninteractive for tests and internal callers; they retain the actionable typed error. If the final reopen fails after the preference was saved, the UI reports that distinction rather than claiming the import failed and inviting a duplicate import.

The marker is a signed declaration of protocol compatibility, not proof of a particular vendor app's current renderer behavior. It does not enable any additional app profile, transport, launch flag or source type.

## Verification scope

The marker guard added five focused native tests: two strict metadata tests, two active-preservation tests, and a signed temporary-helper test showing that a missing marker requires update despite matching runtime digests.

The restart UI change adds ten coordinator tests using only synthetic process identities and in-memory library bytes: cancel, refused quit, edits during the alert/preflight/shutdown/rebuild, rebuild failure, successful sequencing, retry failure without recursive prompts, and unidentified target refusal. Another preservation test exercises an unmarked helper with existing saved JS and confirms exact library/configuration/alias bytes are untouched by read-only inspection. Native alert tests include the new Restart / Not Now context.

On 2026-09-13 at 19:36 local time, the coordinated focused command `swift test --package-path macos --build-system native --filter 'RuntimeUpgradeCoordinatorTests|NativeRestartAlertTests|ActiveLauncherPreparationTests'` compiled the new production/UI sources and passed 20 tests with zero failures (10 coordinator, 8 active-helper preservation, 2 native alerts). The first attempt was interrupted because another agent was saving an unrelated test file during compilation; the coordinated rerun completed normally.

No live updater transition or native UI restart is claimed by synthetic coverage. This reviewer has not launched installed apps or changed the user's library.

The follow-up full native suite at 19:43 local time passed 289 tests, with 3 live opt-in tests skipped and zero failures. It includes an additional save regression: `ExtensionLibrary.save` can now require the exact caller-provided original bytes, refusing a changed first read before updating either the live file or last-good backup. Both staged manager mutation paths pass this snapshot through encoding into the existing final expected-byte write check, closing the gap between their earlier comparison and save's own baseline read.
