# Claude assisted native integration

13 September 2026. Implementation checkpoint; no new live Claude verification is claimed.

## Native behavior implemented

- The built-in `claude` profile requires `/Applications/Claude.app`, `com.anthropic.claudefordesktop`, and `/Applications/Claude.app/Contents/MacOS/Claude`. The installed bundle identifier was read without launching or modifying the app.
- Manager and generated launcher use the shared `.claudeMixed` source policy with the existing 64 KiB CSS, 256 KiB JavaScript, 64 enabled records and 32 files per record limits. The signed helper capability marker binds the exact Claude identifier; a missing or foreign marker cannot enable scripts.
- The helper selects the fixed packaged `dock-claude-session.mjs` entry point with `--library` and `--output`. It does not add target launch flags or write Claude preferences. The existing relocation-safe runtime resolver supplies the broker and Node executable; no build-machine runtime path is introduced.
- A single existing Claude process must pass the normal registry/kernel selection checks. This assisted profile can borrow it without a restart, preserving the user's already-enabled inspector. The broker separately records adoption versus a normal launch and revalidates ownership before attachment.
- `waiting-for-debugger` tells users to choose **Developer → Enable Main Process Debugger** in Claude, with **Help → Troubleshooting → Enable Developer Mode** if the menu is absent. `waiting-for-page` asks for a new chat. These states require a fresh version-1 heartbeat and matching live target process; they are never healthy/running-extension states. Missing-runtime restart prompts are suppressed only for that exact live assisted session.
- Existing restart and runtime-upgrade alerts explain the per-launch setup instead of promising unattended connection. The capability and import surfaces state that the first supported document is exactly `https://claude.ai/new`, that the route is assisted, and that imported JavaScript has not yet passed live Claude verification.
- Inline trust text states that extension scripts can read/change app content, Claude's user-enabled main inspector exposes the full process to other local software, and disabling extensions does not close the inspector. The native Quit command ends the app session. No additional consent modal was added.

## Transport boundary

The Node broker and fixed inspector-to-renderer adapter are implemented separately by the runtime workstream. The agreed bridge uses fixed privileged function declarations and passes command envelopes as data. Imported extension source is forwarded only as renderer CDP command data to the existing isolated-world controller; it is never evaluated as main-process or Node extension code. The bridge must preserve context/event ordering, bound its event queue, refuse an already-attached renderer debugger, and detach only its own connection. No automatic UI operation, private setting, target bundle change or protection bypass is part of this profile.

This transport is feasible because Electron documents [`webContents.debugger`](https://www.electronjs.org/docs/latest/api/debugger) as a renderer protocol transport with commands and lifecycle events. Claude's [official troubleshooting guide](https://claude.com/docs/connectors/building/mcp-apps/troubleshooting) documents enabling Developer Mode and its menu. The additional Main Process Debugger menu and its per-process activation behavior come from the saved installed-app trials, not from a promise in that public guide.

The [historical Claude evidence](../../CLAUDE-DEVELOPER-MODE.md) records Developer Mode persisting while the main inspector had to be enabled again after normal relaunch. Those trials proved fixed CSS application/removal with unchanged signing. They do not prove the new protocol bridge, imported-JavaScript lifecycle, navigation to other chat routes or unattended cold starts.

## Verification status

New native regression cases cover exact path/identifier selection, mixed source binding, helper markers, assisted restart copy, and waiting-state refusal for dead/stale/foreign processes or legacy heartbeats. After the build-11 Figma test released the SwiftPM slot, `swift test --package-path macos --build-system native` compiled the native sources and passed **300 tests, 4 live opt-ins skipped, zero failures** at 20:29:50 local time. The [full log](../../../output/release-review/2026-09-13/native-claude-assisted-full-suite.log) records the result. This includes the selected-profile authoring and TCP/pipe trust text regressions. No live Claude action was performed by this native workstream.

Next acceptance is an owned main-inspector transport proof, followed by a current Claude imported-package trial using its official user-enabled debugger. The existing new-chat route remains fixed until separate source evidence and an explicit scope decision justify another route.

## Opt-in native product proof

`macos/Tests/ClaudeJavaScriptIntegrationTests.swift` is now implemented and compiled. The subsequent ordinary suite passed **301 tests, 5 live opt-ins skipped, zero failures** at 20:35:59 local time; [full compile/suite log](../../../output/release-review/2026-09-13/native-claude-e2e-compile-full-suite.log). This does not run Claude or establish a live pass.

After packaging the matching candidate with the verified broker, run:

```sh
EA_RUN_NATIVE_CLAUDE_PACKAGE_E2E=1 swift test --package-path macos --build-system native --filter ClaudeJavaScriptIntegrationTests
```

The test refuses pre-existing Claude or launcher registrations and rejects a broker-reported adopted process. It uses a fresh isolated Application Support library, in-memory Dock, actual native importer/manager APIs, and a generated signed helper whose runtime digest matches the packaged manager. Evidence includes package/replacement/observer hashes, manager/helper/test-adapter executable hashes, installed Claude version/build and the full broker integrity report. A compiled test adapter is explicitly not described as a manager-GUI import.

The supervisor watches the run's `next-action.json` under `output/release-review/2026-09-13/native-claude-package-<UUID>/`:

1. Checkpoint **0** appears while waiting for the official debugger/new-chat setup. It allows 180 seconds. If enabling Developer Mode restarts Claude, that ends the current process-bound proof; complete normal setup and use a fresh run. Already-active setup is recorded separately without claiming that a menu click was observed.
2. Checkpoint **1** requests one real click on the green **Claude extension proof** button. The fixed observer reports only the test-owned DOM marker, click count and CSS values; extension logs attribute the click to its source.
3. The test disables, re-enables, removes and re-imports a changed package. Checkpoint **2** requests Claude's native Reload command followed by one click after the button returns. It requires a new document marker and exactly one handler; both click checkpoints allow 180 seconds.

Final removal must preserve the running target and helper until all cleanup is acknowledged. The test then normally quits only its own helper, requires script/CSS cleanup and owned renderer-debugger detachment, and independently confirms the same Claude PID/start time remains alive. It never quits Claude. The supervisor may explicitly quit that newly launched target normally afterwards to close the main inspector. All original app files and signatures must match before, during and after cleanup.
