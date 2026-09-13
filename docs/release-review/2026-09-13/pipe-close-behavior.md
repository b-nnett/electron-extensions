# Debugging-pipe shutdown can normally quit the app

Closing an Electron debugging pipe can cause the target app to quit normally. It is not safe to promise that a pipe-launched app always stays open when its helper stops.

This is explicit in the official source corresponding to Figma's observed Electron 42.11.1: the remote-debugging-pipe disconnect callback schedules `Browser::Quit()` on the UI thread. A normal quit may still be handled or canceled by the app. This behavior requires no signal or `Browser.close` command. See [Electron 42.11.1, electron_browser_main_parts.cc, lines 482–489](https://raw.githubusercontent.com/electron/electron/v42.11.1/shell/browser/electron_browser_main_parts.cc).

## Ordinary disable versus stopping a session

Disabling the last enabled extension does **not** stop the current broker:

- `macos/Sources/ExtensionManager.swift:261` calls launcher reconciliation after saving the changed library.
- `macos/Sources/ElectronLauncher.swift:658` restores the verified Dock entry when no extensions remain; this method does not signal the helper or broker.
- `scripts/dock-catalog-session.mjs:48` removes CSS and synchronizes an empty script selection, then reports `disabled`. Its watcher continues at line 566, retaining the pipe and allowing re-enable.

Explicit helper termination is different. `macos/Launcher/LauncherMain.swift:238` routes helper Quit to `requestQuit`, which signals its own broker. The broker verifies script cleanup and stylesheet removal, detaches its selected page, then closes its pipe. `lib/pipe-cdp.mjs:190` destroys both transport streams. Electron may then normally quit the target. Broker failure, process termination or another operation that closes these pipe endpoints can have the same target-side effect; this document does not claim every application cancels or accepts that normal quit in the same way.

Recovery guidance: use extension toggles to remove changes while keeping a pipe-managed app open. If deliberately stopping its helper, expect that the target may also quit and allow the target's ordinary unsaved-work handling to finish. Reopen it normally for an unextended session, or through its extension launcher when extensions should run. No app bundle patch or re-signing is involved.

## Original Figma report correction

The preserved native attempt under `output/release-review/2026-09-13/native-figma-package-C0E0F2DF-8498-49E2-AF0F-6E00E4165AB8` reached initial imported CSS/JavaScript application, then timed out at an interaction checkpoint while the macOS session was locked. Its test cleanup explicitly stopped the owned helper. Broker session `597C2325-6849-4A44-93B9-D3324781CB33` recorded normal process exit at `18:56:28.428Z`, before report completion at `18:56:28.539Z`, but retained an earlier `launchedAppLeftRunning: true` sample. That survival field was stale and must not be treated as proof that Figma remained open. The historical evidence is preserved rather than rewritten.

The corrected broker performs a fresh kernel identity lookup after transport closure and the final bundle-integrity work. Its cleanup now includes:

```text
pipeCloseMayQuitApp: true for pipe sessions
transportClosedAt: observation timestamp
finalProcessObservation: { observedAt, sameProcessAlive: true | false | null, reason }
launchedAppLeftRunning: the late observation's sameProcessAlive
```

An exit event observed during the identity lookup overrides a stale returned alive snapshot. Positive absence and PID reuse mean the original process ended. A reader failure or mismatched executable remains unknown. Any true value is an observation at `observedAt`, not a promise of continued future survival. Existing `targetTerminationRequested: false` means the broker sent no direct target termination signal/command; `pipeCloseMayQuitApp` makes the indirect pipe effect explicit. Normal expected app exit does not erase separately verified CSS/JavaScript cleanup or hide failed cleanup.

## Owned fixture evidence

The fixed `/Applications/Style Lab.app` proof was rerun with a bounded observation interval after pipe closure and **before any process signal**. All imported-runtime checks passed. Its Electron 44.2.0 app exited normally 132 milliseconds after the pipe closed:

| Event | UTC timestamp / result |
| --- | --- |
| Pipe closed | `2026-09-13T19:08:15.245Z` |
| Exact child exit | `2026-09-13T19:08:15.377Z`, code `0`, signal `null` |
| Direct termination signal sent | `false` |
| Final kernel observation | `2026-09-13T19:08:15.592Z`, original process ended |
| Integrity | All 265 files and code signature unchanged |

Evidence: `output/release-review/2026-09-13/imported-pipe-2aa30119-c9ee-40bf-bbbf-59327b96cb27/report.json`; runner: `scripts/testing/verify-imported-pipe-runtime.mjs`. The temporary owned profile was removed only after that child's confirmed exit. This is a transport behavior proof and source-supported explanation of the Figma result, not a completed Figma interaction/reload proof.
