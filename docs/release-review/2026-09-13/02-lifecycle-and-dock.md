# Release review 02: launch lifecycle and Dock

Date: 13 September 2026. Reviewer: independent lifecycle/Dock subagent.

**Verdict: NO-GO for a general release.** The normal restart and scoped Dock paths have useful implementation and fixture evidence, but the app still depends on the builder's runtime installation, and a failed generated-launcher update can leave an existing Dock shortcut unrecoverable through the normal controls. DMG presentation, distribution signing/notarization, and the new manager auto-updater are outside this review.

This was a read-only source/test/evidence review. I did not launch, restart, quit, inspect user content in, or change any installed target app, and did not change Dock preferences. Existing suites were not rerun. Findings below describe current source at review time; the root agent is implementing updater work concurrently.

## Findings

### P1 — Runtime launch depends on an absolute path from the build machine

**Location:** `scripts/build-macos.mjs:49`, `macos/Sources/ElectronLauncher.swift:356`, `macos/Sources/ElectronLauncher.swift:464`, `macos/Launcher/LauncherMain.swift:151`.

The build writes `process.execPath` into `LaunchEnvironment.json`. Preparing a runtime shortcut requires that exact absolute path to be executable, writes it into the helper's adjacent configuration, and the launcher executes it. The builder's Node installation and dynamic-library dependencies are not packaged by this path. A user who has no Node at the builder's exact path cannot enable a tweak/prepare its launcher; the operation fails with the generic missing-runtime error. Having Node elsewhere does not satisfy the check. This is a runtime prerequisite failure, independent of whether the app is distributed in a DMG or ZIP.

The broker also unconditionally executes `/usr/bin/python3` for process identity in `lib/process-identity.mjs:104`. That interpreter is a second external dependency with no bundled fallback in the reviewed code. I did not test a Mac without developer tools; its presence on the development machine is not clean-install evidence. `macos/README.md:19` and `docs/DOCK-LAUNCHING.md` already identify external Homebrew Node as a development limitation.

**Required outcome:** bundle and resolve a relocatable supported runtime, including its libraries, and provide a shipped native identity reader or otherwise eliminate/explicitly satisfy the Python prerequisite. Verify a runtime-profile launch on a clean account/Mac with no Homebrew or developer tool runtime assumed. Existing generated helper configurations must migrate as needed.

**Confidence:** definite source dependency; fresh-Mac failure follows when the required absolute executable is absent. No fresh-Mac trial was performed in this review.

### P1 — Interrupted helper refresh can permanently strand an existing shortcut

**Location:** `macos/Sources/ElectronLauncher.swift:440`, `macos/Sources/ElectronLauncher.swift:524`, `macos/Sources/ElectronLauncher.swift:540`.

The initial helper install is staged, but subsequent updates mutate the installed `.app` in place: replace its Runtime directory, replace its executable, write the catalog, write the new source hash into `Info.plist`, and then re-sign. The old Runtime backup is deleted as soon as the Runtime move succeeds, before the remaining helper update is complete.

A concrete failure sequence is an interruption or signing error after the new `Info.plist` is written at line 448 and before signing at line 449 succeeds. The helper now has the *current* source hash with an invalid old signature. Every normal preparation skips the update block because the hash matches and fails strict verification at line 451. Background refresh also treats the hash as current and goes directly to strict verification at line 536. **Open App** and **Add to Dock** both run preparation, so they cannot repair this state. The existing alias and pin still reference the broken helper. The refresh queue records the error once and marks the app finished for that manager lifetime (`ExtensionRuntimeMonitor.swift:79`), rather than restoring a working helper.

There is another interruption window between moving the old Runtime directory aside and putting the replacement in place; the catch block can undo a thrown move failure, but a terminated process does not execute it and there is no startup recovery of the `.previous-runtime-*` directory.

**Required outcome:** stage, sign, and verify a complete replacement helper before a recoverable whole-bundle swap. Retain a valid previous helper until commit succeeds, recover an interrupted swap, and allow a matching metadata hash plus invalid installed signature/runtime to rebuild from the trusted bundled source. Add fault-injection tests after each commit boundary, including a matching-hash/invalid-signature retry. Coordinate this with the manager updater because routine application updates will exercise this path.

**Confidence:** definite source/control-flow failure path. No crash or signer failure was induced against the user's real helper.

### P2 — The automatic Dock-drag fallback is still not validated with an actual drop

**Location:** `macos/Sources/DockInstallWindow.swift:140`; evidence limit explicitly recorded in `macos/README.md:29` and `docs/DOCK-LAUNCHING.md:147`.

When programmatic pinning fails, the production recovery path relies on a drag being accepted, a matching alias or resolved-helper entry being persisted within three seconds, and a new or moved matching index. Existing evidence verifies programmatic pinning and simulated pickup/close callbacks, but expressly does not establish a real accepted Dock drop and automatic panel dismissal. A successful preference write is not evidence for this fallback. The undocumented Dock tile normalization is particularly relevant here.

**Release gate:** on each supported macOS major version, capture a real fallback drop, automatic dismissal, immediate autohide restoration, cancellation, and a drop elsewhere. Keep the before/after matching pin and unrelated preference evidence. This is an evidence gap, not a demonstrated defect. A manually dropped tile is intentionally not adopted into a programmatic receipt (`docs/DOCK-LAUNCHING.md:123`); last-disable automatic restoration/removal must not be promised for that path.

## What has support

- Restart confirmations use `NativeRestartAlert`; user approval precedes normal termination. Both restart services bind the selected PID/start identity and reject changed processes, declined quit, timeout, and cancellation. The launcher re-reads its configuration/library after quit.
- The recent stale LaunchServices registration correction is covered by synthetic cases in `RuntimeLauncherRestartServiceTests`; the documented Style Lab fixture verified the final normal restart and active CSS result. ChatGPT cancellation preserved the existing session. An actual vendor updater restart was not exercised by that fixture check.
- Runtime heartbeat freshness and process identity are checked before calling a session healthy. The monitor has an explicit 45-second disconnected grace period and suppresses repeated prompts for the same process after a decision.
- Dock replacement/removal uses an owned tile/GUID receipt and current pin positions, tolerates documented cache normalization, and preserves unrelated edits. Tests include interrupted write recovery, duplicate/changed pins, and additions that were removed and later reappeared.
- Dock autohide is restored on popup close and normal manager termination; a recovery receipt supports the next manager startup after interruption. A crash can leave the preference changed until that startup, which is a remaining behavior to document rather than a claim of an always-running ten-second lease.
- Existing helper refresh defers active/uncertain helpers and leaves aliases, Dock preferences, the extension library, and configuration unchanged in the background path. The documented real Style Lab refresh verified that behavior during an active session and after exit.
- Production brokers leave the user's target running when their controller stops; fixture cleanup is separately owned. I found no target-bundle rewrite or force-quit addition in the native restart paths reviewed here.

## Evidence used

- `docs/NATIVE-RESTART-ALERTS.md`: native-alert live fixture flows, ChatGPT cancellation, and explicit scope limits.
- `docs/RESTART-AND-APPEARANCE-REGRESSIONS.md`: transient-registration correction, helper refresh observation, final Style Lab restart, and preserved ChatGPT session/library.
- `docs/DOCK-LAUNCHING.md`: scoped receipts, previous live preference trials, fallback limits, and external runtime dependency.
- `macos/Tests/AppRestartServiceTests.swift`, `RuntimeLauncherRestartServiceTests.swift`, `RestartPromptPolicyTests.swift`, `LauncherRefreshQueueTests.swift`, `DockShortcutTests.swift`, `DockVisibilityTests.swift`, and `ElectronLauncherTests.swift`.

The latest documented regression validation was 167 Swift tests (one opt-in live test skipped, zero failures) and 153 passing Node tests. Those historical results are not a test run of the new updater or of changes made after the evidence was written, and they do not establish fifty-app end-to-end release coverage.
