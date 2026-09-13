# Native restart alerts — 13 September 2026

Both the runtime monitor and generated shortcuts use `NativeRestartAlert`, an AppKit `NSAlert` with **Restart** (Return) and **Not Now** (Escape). The monitor presents the alert automatically after its existing 45-second disconnected grace period. A shortcut presents it immediately when enabled CSS requires relaunching an already-running app.

Restart requests a normal quit. The shortcut checks the selected app's exact bundle, executable, user, PID, and kernel start time before requesting quit and while waiting up to 30 seconds. It revalidates the launch configuration, extension library, and packaged runtime after exit. Cancellation, declined quit, timeout, changed identity, and replacement processes prevent relaunch. The monitor retains its existing checked restart service.

The monitor uses a nonblocking AppKit modal session so monitoring continues while the native alert is visible. It can dismiss a stale alert when the app exits, reconnects, or the restart setting is disabled.

## Live verification

The release app was rebuilt and reopened. Interactions below used the actual native UI; alert and full fixture-window screenshots were inspected in the task conversation.

| Flow | Observed result |
| --- | --- |
| ChatGPT automatic monitor prompt | Native alert with app icon and Restart / Not Now. Not Now recorded `restartDeclined`; existing PID 63089 remained running. |
| Style Lab automatic monitor prompt | Native alert appeared without opening a shortcut. Restart recorded `restartAccepted` for PID 68310; that process exited normally and managed PID 68812 reached an active session with green CSS. |
| Style Lab shortcut, Not Now | Native “Restart Style Lab with extensions?” alert. Not Now closed the helper and left normal PID 69173 running. |
| Style Lab shortcut, Restart | Reopening the helper prompted again. Restart normally quit PID 69173 and opened managed PID 69373. Its button was green, session active, and the bundle fingerprint/signature matched the baseline. |
| ChatGPT updated shortcut | The manager refreshed the existing generated helper. Its native alert offered Restart / Not Now instead of the OK-only launch error. Not Now closed the helper; PID 63089 remained running. |
| Cleanup | Style Lab quit through its own menu; its helper/broker exited and temporary profile was removed without forced termination. Extensions Anywhere remained open. ChatGPT was not restarted. |

Both Style Lab restart sessions verified `rgb(22, 163, 74)` button styling with an unchanged signature and SHA-256 fingerprint across all 265 bundle files. Final strict signature verification passed for Style Lab, ChatGPT, and the rebuilt manager. Only our manager and generated helper bundles were rebuilt/signed.

Evidence: [monitor report](../output/native-restart-alerts/2026-09-13/monitor-report.json), [shortcut report](../output/native-restart-alerts/2026-09-13/shortcut-report.json), [event journal](../output/native-restart-alerts/2026-09-13/runtime-events.json), [cleanup](../output/native-restart-alerts/2026-09-13/fixture-cleanup.json), [Swift tests](../output/native-restart-alerts/2026-09-13/swift-tests.log), and [release build](../output/native-restart-alerts/2026-09-13/build.log).

Swift validation: 156 tests, zero failures, one opt-in catalog live-action test skipped. All [147 Node tests](../output/native-restart-alerts/2026-09-13/node-tests.log) passed, including six tests for matching the native alert by app text, named controls, geometry, and pending process identity. The catalog UI helper itself was not run live during this check. The new coverage includes native alert button configuration and 14 synthetic shortcut restart lifecycle tests. This check does not establish a ChatGPT restart, an actual vendor update, or completion of the separate 50-app validation effort. Fixture cleanup followed app exit, so explicit stylesheet removal was unavailable; runtime CSS ended with the process.
