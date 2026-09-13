# Packaged native process identity: Python dependency removed

The production broker no longer invokes `/usr/bin/python3` for process identity. `lib/process-identity.mjs` now executes our packaged `ProcessIdentity` native utility, which uses the same SDK-imported `proc_bsdinfo` and `libproc` reader as the Swift lifecycle checks. This closes the source-level Python/Command Line Tools dependency identified in [review 4](04-portability.md); final app packaging is integrated separately by the root agent.

## Implementation and interface

- `macos/ProcessIdentity/ProcessIdentityMain.swift` is a new Swift executable target named **ProcessIdentity**, depending on **RuntimeCatalog**. It accepts exactly one JSON argument containing 1–8192 unique positive signed 32-bit PIDs, bounds input to 128 KiB, and writes a JSON result array to stdout. Malformed input exits with `EX_USAGE` (64) and does not emit process records.
- `macos/Shared/RuntimeProcessIdentity.swift` supplies the reusable reader. It checks complete SDK-structure reads before accessing fields, reads process identity before and after the kernel path, preserves six-digit microsecond start times, and rejects changed PID/start time/UID, malformed paths, unknown state, and zombies as uncertainty.
- Successful records retain the existing broker contract: `pid`, `status: "ok"`, `executable`, `started`, `uid`, and `ppid`. `status: "absent"` is emitted only after a positive `kill(pid, 0)`/`ESRCH` result and includes `errno: 3` plus `confirmedBy: "kill-0"`. A libproc failure alone never implies absence. Permission failures and ambiguous results remain explicit error records.
- Runtime lookup is fixed relative to the packaged module: `Contents/Resources/Runtime/native/ProcessIdentity`. Raw checkout commands locate the same built utility under `dist/Extensions Anywhere.app/Contents/Resources/Runtime/native/ProcessIdentity`. A malformed application layout, missing reader, or symlinked reader fails closed. There is no Python, PATH, Homebrew, download, or runtime-compilation fallback.

The utility reads kernel metadata only. It does not read process arguments, environment, app content, or mutable process names; it does not launch or terminate applications. The `kill-0` existence probe sends no signal.

## Verification

**6 focused Swift tests and 19 Node tests passed, with zero failures.** An isolated temporary Swift package compiled the exact new CLI/shared-reader/test sources to avoid competing with the main application's concurrent build. The Node checks used copies of the exact production module and native artifact in a temporary packaged layout.

The Swift tests cover stable identities and microsecond padding, parent-PID output, PID/start/UID changes, malformed paths/state, permission/ambiguous failures versus confirmed absence, and an actual read of the current owned test process. Existing AppKit lifecycle semantics remain unchanged; the shared internal SDK reader now also returns parent PID.

The Node checks cover invalid CLI inputs and bounds, an actual owned-process query with only `/usr/bin:/bin` in PATH, actual absence after an owned child exited normally, relocation, missing/symlinked-reader rejection, and the existing identity decoder's fail-closed cases. The live inventory test is scoped to its own PID; no third-party applications were inspected by these tests. `otool -L` on the isolated native artifact lists only system frameworks/libraries.

Saved evidence:

- [Verification record](../../../output/release-review/2026-09-13/native-identity/verification.json)
- [19 Node test results](../../../output/release-review/2026-09-13/native-identity/node-tests.log)
- [Native dynamic-library inspection](../../../output/release-review/2026-09-13/native-identity/native-library-links.txt)

To run these tests against the final application artifact, first build the native app so the packaged reader exists, then run `node --test tests/process-identity.test.mjs tests/native-process-identity.test.mjs` and the `NativeProcessRecordTests` Swift tests. The root agent owns the SwiftPM product declaration, embedding, SDK validation, and signing of this new executable, plus standalone Node integration.

## Remaining limits

These checks establish the interpreter-free implementation and its JSON/identity behavior. They do not establish a fresh-machine, minimum-macOS, Intel, notarization, updater-installation, or complete extension session result. Final packaged-artifact validation and the separate Node dependency fix are still required before declaring portability ready for release. No target bundles, Dock preferences, or user extension-library records were changed by this work.
