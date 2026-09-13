# Restart and appearance regressions — 13 September 2026

## Restart error

The reported alert came from the new launcher's `ambiguousApp` check. The first attempt was not logged before the broker session started, so its precise interleaving cannot be established retrospectively. The later session confirms that ChatGPT did successfully open as PID 71009 with both stored stylesheets active.

A definite failure path was found in `RuntimeLauncherRestartService`: while the selected app quits, AppKit can mark its registration terminated between the kernel identity read and construction of the registration snapshot. The snapshot then retains the original PID and bundle but has no process identity. The previous code treated this as a conflicting instance immediately, before checking whether the selected process had exited. This is consistent with the reported error disappearing on the next Open attempt.

After a validated, user-approved normal quit, the service now waits for that exact old registration to clear within its existing 30-second deadline. It still requires positive kernel exit before reopening, rejects a changed PID/start time/executable/user or a different app registration, and never repeats the quit request. Four regression tests cover the transient sequence, persistent uncertainty, and replacement identities.

## Liquid Glass appearance

The rebuilt manager recorded `LC_BUILD_VERSION` with both minimum OS and SDK set to 14.0, although the selected toolchain was Swift 6.4 with SDK 27.0. A fresh temporary Swift package reproduced this under the default build backend even with an explicit SDK path. This was a build regression; the SwiftUI window styling had not been edited.

The packaging script now selects the SDK and compiler explicitly, uses the supported `native` SwiftPM backend, isolates its build cache by toolchain/SDK identity, and checks all three executable products before packaging. Each must report the selected SDK while retaining the macOS 14 deployment minimum. The corrected real build reports SDK 27.0. `BuildEnvironment.json` inside our app records that provenance.

The rebuilt app was opened and inspected through its native UI. The app-name glass capsule, rounded toolbar controls, pill-shaped Add Extension button, and modern switches returned. ChatGPT remained connected as the same PID 71009. No system appearance setting or target-app bundle was changed.

See the [build diagnosis and fresh reproduction](../output/liquid-glass-build/2026-09-13/diagnosis.md), [reported screenshots and initial metadata](../output/native-restart-alerts/2026-09-13-regressions/), and [native build instructions](../macos/README.md).

## Existing Dock launchers

The manager now queues already-existing managed launchers for refresh during its lifetime. Active or uncertain helpers remain pending; each poll attempts at most one stopped helper. Automatic refresh updates only the existing helper bundle, verifies its installed build, and leaves the alias, configuration, extension library, and Dock preferences alone. It does not create new helpers through discovery. A real refresh error is recorded once without showing another alert. This maintenance runs while Extensions Anywhere is open; active ChatGPT continues using its current helper until that helper exits.

Live verification held the old Style Lab helper open while the final manager started: the helper's sealed source hash stayed unchanged and both Style Lab and ChatGPT remained connected. Quitting Style Lab normally let its helper exit; the queue then recorded `launcherBuildUpdated` and changed the helper's linked SDK from 14 to 27. The alias, configuration and persistent Dock entries matched their baseline hashes. [Refresh result](../output/native-restart-alerts/2026-09-13-regressions/helper-refresh-result.json).

The automatically refreshed helper was then opened against normally running Style Lab PID 77392. Accepting the native alert's default Restart action normally quit that process and opened PID 77673 with the green stylesheet active and an unchanged signature/fingerprint. The fixture was subsequently quit through its own menu; its helper exited and temporary profile was removed without forced termination. ChatGPT remained PID 71009, and the extension library hash was unchanged. [Final result](../output/native-restart-alerts/2026-09-13-regressions/result.json), [restart report](../output/native-restart-alerts/2026-09-13-regressions/restart-report.json), [event journal](../output/native-restart-alerts/2026-09-13-regressions/runtime-events.json).

Final validation: 167 Swift tests with one opt-in live test skipped and zero failures; all 153 Node tests passed. This includes four new restart-race cases, seven refresh-queue cases, and six SDK/build-metadata cases. [Swift log](../output/native-restart-alerts/2026-09-13-regressions/swift-tests.log), [Node log](../output/native-restart-alerts/2026-09-13-regressions/node-tests.log). The original ChatGPT error's precise timing remains unproven; the regression sequence is reproduced by a synthetic lifecycle test. No ChatGPT restart was performed during this follow-up.
