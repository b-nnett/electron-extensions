# Sparkle local installation test

Date: 2026-09-13. Sparkle: vendored 2.9.6. Scope: our signed manager app only, copied under the repository's `output` directory. No installed third-party app was launched, probed, modified, or re-signed by this work.

## Result

**PASS for a real signed-copy replacement and a separate harness restart. This is not proof of the production manager's own automatic restart.**

The first observed receipt recorded build 2 → build 3, the expected Developer ID team `X522N436T7`, a valid host signature, and the expected build 3 executable SHA-256. The harness restarted with a different PID. The immutable build 2 baseline still validated. All 12 mutable Sparkle preference keys were restored and compared to their saved values. An independent `codesign --verify --deep --strict` of the installed test copy passed after installation.

| Check | Observed result |
| --- | --- |
| Initial signed app | Version 0.1.1, build 2 |
| Installed signed app | Version 0.1.2, build 3 |
| Initial executable SHA-256 | `4aaa7c08952a3b15989a094569e67dd80126a97dcd5b846d9ba209cef6362aaf` |
| Installed executable SHA-256 | `5d7e79cb1935dfa95dd2d06c0f47536a14038d16ff1f559f5c86bd8b7f6f2ee3` |
| Initial harness PID | `26084` |
| First observed restarted harness PID | `26147` |
| Sparkle restart request | `2026-09-13T15:22:50Z` |
| First observed successful verification | `2026-09-13T15:22:54Z` |
| Real manager launched by this harness | No |
| Production HTTPS feed tested by this harness | No; a signed loopback feed was used |
| Host updater preferences | Exact 12-key snapshot restored and verified |

## Evidence provenance correction

The first harness implementation rechecked the installed copy whenever it launched after an installation. A later root CUA `getApp` call apparently launched the harness again, producing PID `26443` at `15:23:38Z` and overwriting the original `installation-result.json`. That later receipt verifies the installed signed copy, but its PID must **not** be represented as the first Sparkle restart.

The subagent had already read the original result before it was overwritten. `first-observed-installation-result.json` preserves those observed values and explicitly identifies itself as reconstructed from the earlier tool output, not an original untouched on-disk receipt. The later receipt is preserved too. `state.json` contains the original process and the Sparkle `updaterWillRelaunchApplication` callback time.

Neither this subagent nor root clicked the initial update/install prompts. This subagent only opened the harness. Root's first CUA observation was the completion alert, and root clicked Done. The prompts were ordinary user-controlled AppKit/Sparkle prompts; the harness has no automatic acceptance code. Do not attribute the earlier prompt interactions to root or invent a recorded click trace.

The source is now idempotent: once a receipt exists, another launch shows an already-complete message without running Sparkle, writing another receipt, or restoring stale preferences. Final receipt creation uses an exclusive write. This source-only follow-up passed Swift type checking; the installation was not repeated. The executed harness is preserved in `output/release-review/2026-09-13/updater-install-test/executed-test-harness.zip`; its stale launchable app copy was removed after the test. Build the corrected source for a future new test.

## How the test is scoped

The public initializer `SPUUpdater(hostBundle:applicationBundle:userDriver:delegate:)` deliberately separates the bundle being updated from the application to terminate and restart. Sparkle's own command-line driver supports this split. Our harness uses:

- Host: `output/release-review/2026-09-13/updater-install-test/Host/Extensions Anywhere.app`
- Application to restart: `output/release-review/2026-09-13/updater-install-test/Sparkle Install Harness.app`
- Immutable baseline: `output/release-review/2026-09-13/notarization/build-2/Extensions Anywhere.app`
- Expected new signed build: `output/release-review/2026-09-13/notarization/build-3/Extensions Anywhere.app`
- Feed override in the test delegate only: `http://127.0.0.1:8767/appcast.xml`.

The host copy is made with `ditto` and its signature is verified. The harness does not change the host's Info.plist, signature, pinned Ed25519 public key, production HTTPS feed, or requirements for signed feeds and signed archives before extraction. The root prepared and signed the loopback appcast and ZIP using the configured update key. The accepted appcast enclosure must name build 3 and a ZIP on the fixed loopback host/port. The native Sparkle user driver performs the real update flow and validation. Only the disposable harness is ad-hoc signed; the original and replacement manager apps retain their Developer ID signatures.

The harness verifies fixed output paths, rejects symlinked path components, checks the exact manager bundle identifier, version, signed updater configuration, and expected Developer ID team. It validates the host signature through Security.framework and compares the installed executable hash to the independently signed build 3 baseline. It never invokes the manager executable. A completed update-check callback alone is never treated as successful installation.

Returning false from `updaterShouldRelaunchApplication` is **not** an installation-without-relaunch technique in this Sparkle version: `SPUInstallerDriver` aborts the installation when that check fails. The supported separate `applicationBundle` is what makes this test possible.

## Preferences, caches, and isolation

An external host bundle still selects the host's preferences suite in `SUHost`. A different harness bundle identifier does not isolate that suite. The harness therefore refuses to start while the real manager is running, takes an exact snapshot of Sparkle's 12 mutable host-domain keys, and restores only those keys. It never replaces the whole preferences domain or resets `cfprefsd`.

The snapshot covers automatic checking/downloading, check interval, profiling consent/date, first-launch and last-check dates, feed override, phased-update group, and skipped versions. Values are stored in a local mode-0600 property list; the JSON evidence lists only key names. Restoration checks equality with the snapshot. This does not give transactional protection against a user starting the real manager and changing updater settings mid-test; the harness detects a running manager and fails instead of restoring in that situation.

Normal Sparkle cache/helper/log metadata may remain under its normal locations. This is not a fully isolated macOS-account test. No extension library path is opened by the harness, and no cleanup was performed against the user's cache, preferences directories, or existing application data. Root separately owns any later real-manager launch and library-preservation checks.

`CFFIXED_USER_HOME` was investigated but intentionally **not relied upon**. Apple's archived [CFPlatform.c](https://github.com/apple-oss-distributions/CF/blob/main/CFPlatform.c) and [CFPreferences.c](https://github.com/apple-oss-distributions/CF/blob/main/CFPreferences.c) show historical CoreFoundation home/preference-path support. They do not establish that this override isolates current macOS `cfprefsd`, LaunchServices, or Sparkle's XPC helpers. Setting that environment variable would not honestly prove end-to-end isolation.

## Implementation and repeat instructions

Source:

- `scripts/testing/SparkleInstallHarness.swift`
- `scripts/testing/build-sparkle-install-harness.py`

The builder only prepares and compiles; it never opens the harness. It rejects existing test app/host/state/snapshot artifacts and preserves separately prepared feed/server files. For a future run, preserve the completed test directory as evidence and deliberately choose a new fixed test directory in both test-only sources before building. Do not blindly delete or reset this completed run.

Build from the repository root:

```sh
python3 scripts/testing/build-sparkle-install-harness.py
```

The prepared app contains the pinned Sparkle framework, a small Swift/AppKit executable, and a test-only local-network ATS allowance. After the signed loopback feed/server is ready, open the harness, choose Check for Updates, and interact with Sparkle's standard install/restart UI. No automated UI acceptance is used.

For an interrupted test only, the generated executable has an explicit `--restore-preferences` mode. Quit the real manager normally before using it. Do not restore an old completed-run snapshot after intentionally changing updater settings: that would overwrite those newer settings. The corrected normal launch path never does that after a completed result.

```sh
"output/release-review/2026-09-13/updater-install-test/Sparkle Install Harness.app/Contents/MacOS/SparkleInstallHarness" --restore-preferences
```

## Proof limits

This run exercises a real signed appcast/archive download, extraction and signature validation, replacement of the signed host copy, installer termination/restart coordination through Sparkle's supported split-bundle mode, and post-install signature/version/hash validation. It does not prove production HTTPS hosting, background scheduling, real manager self-restart, extension reconnection after that restart, rollback, all installer permission/error paths, other macOS versions, Intel hardware, or a bundle installed in `/Applications` with different ownership permissions. Those are separate checks and must not be inferred from this result.

Vendored source references: `Sparkle/SPUUpdater.h` (public initializer), `sparkle-cli/SPUCommandLineDriver.m` (split-bundle client), `Sparkle/SPUInstallerDriver.m` (separate host/relaunch paths and abort behavior), `Autoupdate/AppInstaller.m` (termination monitoring and relaunch), `Sparkle/SUHost.m` (host preference suite), `Sparkle/SPUUpdater.m`, `SPUUpdaterSettings.m`, `SPUSkippedUpdate.m`, and `SUPhasedUpdateGroupInfo.m` (mutable preference keys). All are under `macos/.build/checkouts/Sparkle/`.
