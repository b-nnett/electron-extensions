# Review 7 — Automatic updater

Date: 2026-09-13. Reviewer: independent subagent `release_07_updater`.

**Verdict: NO-GO for public release yet; updater integration and live feed checking pass.** Sparkle is configured, the signed GitHub feed is reachable, and the native checker successfully handles that feed. The actual installation/relaunch round trip remains unproven. This verdict does not depend on DMG packaging.

## Blocking findings

1. **P1 — There is no verified release update transition.** The current packaged manager passes deep/strict signature verification but is **ad hoc signed**, with no TeamIdentifier. `output/updater/2026-09-13/signed-smoke/verification.json` correctly records `developmentTest: true` and `publishable: false`; its verified signatures prove local signing, not Sparkle installation. Before release, test a genuinely older, Developer ID signed/notarized manager updating to a newer signed/notarized manager through the chosen HTTPS feed. Verify normal quit/relaunch, preserved extension library and preferences, and active helper sessions remaining usable. Also verify failed/corrupted and interrupted downloads through the actual updater. Local signature rejection is already covered below. Do not equate signature generation, framework loading, or a successful empty-feed check with the full transition.

## Issues resolved during review

- **Feed availability — resolved.** The configured URL initially returned 404. After the user authorized publishing, root created the public repository and a bootstrap release containing only a signed empty feed. An independent subsequent HTTP request returned **200**. The local signed bootstrap and root's downloaded live feed have identical SHA-256 `42da7ea5ef61c879dd631c8c7ea85519097207d36cedac202fd200099f86527d`. Root reports successful Sparkle signature verification and a native “You're up to date” check; its screenshot is `output/updater/2026-09-13/live-feed-alert.png`. No application binary has been published. The empty feed is a working initial update endpoint, not evidence of an installed update.
- **Preparation tool path — fixed and verified.** The initial preparation script defaulted to the ordinary SwiftPM artifacts directory while the build uses an SDK-keyed native scratch directory. After this reviewer reported the mismatch, `scripts/build-macos.mjs:56` now writes `sparkleArtifactRoot` into build metadata and `scripts/prepare-update.mjs:35` derives its tools directory from that metadata. The explicit `--tools` override remains available. The revised source and JavaScript syntax check pass review. Root completed the rebuild and preparation without `--tools`; the inspected `output/updater/2026-09-13/final-signed-smoke/verification.json` confirms feed and archive signatures verified, with ZIP SHA-256 `5e57869b021538c33ae7ab6495e04d180c29e5ff9c13d6520ee1f4c0677f5498`. The durable record is `docs/release-review/2026-09-13/updater-artifact-verification.json`. This remains an explicitly non-publishable development smoke, not an installation round trip.

## Non-blocking improvement

- **P2 — An update relaunch can discard an unfinished authoring draft.** `macos/Sources/CreateExtensionView.swift:8` stores the brief and project folder only in memory; `macos/Sources/ExtensionsAnywhereApp.swift:59` owns that draft as window state. `macos/Sources/AppUpdater.swift:18` supplies no updater delegate, and `macos/Sources/DockInstallWindow.swift:307` has no termination guard. This also exists for ordinary Quit. Persist the draft or warn before termination when it contains user work.

## What was verified

- Sparkle is pinned to **2.9.6**, with a resolved source revision and an upstream binary checksum. The manager links Sparkle; generated target-app launch helpers do not acquire that dependency.
- `AppUpdater` starts once on the main actor, reports configuration/startup errors, uses Sparkle KVO publishers for settings/menu validation, and does not reset user update preferences on launch. Automatic checking is enabled; automatic download/installation is opt-in.
- Build-time feed validation pins the selected GitHub repository and HTTPS URL. Runtime validation requires an HTTPS URL, a canonical 32-byte Ed25519 public key, signed feeds, and verification before extraction. Feed-signature failure expiry is disabled; release-note JavaScript and profiling are disabled. Only the public key is in project configuration.
- The embedded `Sparkle.framework` symlinks point to `Versions/B`; `otool -L` shows `@rpath/Sparkle.framework/Versions/B/Sparkle`; the executable has `@executable_path/../Frameworks` in its rpaths. `codesign --verify --deep --strict` passed for the packaged app. The nested signing order and Downloader entitlement preservation match Sparkle's manual signing guidance.
- `prepare-update.mjs` rejects a nonempty output directory, verifies bundle identity/updater configuration and the bundle signature, requires Gatekeeper acceptance except with explicit `--development-test`, checks that the Keychain key matches the bundled public key, and verifies the generated feed and archive signatures. It performs no publishing. The development smoke appcast contains a signed enclosure for build 1 and an `arm64` hardware requirement.
- `output/updater/2026-09-13/signed-smoke/tamper-verification.json` records successful original-archive verification, rejection of modified archive bytes, and Sparkle rejecting the modified feed with exit code 1. These are signature-verification checks, not a UI-driven failed-download/recovery test.
- Independently ran `node --test tests/update-settings.test.mjs`: **4 passed, 0 failed**. Root supplied the completed native build and results of **170 Swift tests, 1 opt-in live test skipped, 0 failures**; these latter results were not rerun by this reviewer to avoid competing builds.
- No live target app was opened/restarted, no extension library was modified, and no signing key was exported by this reviewer.

## Scope and remaining limits

This review assesses manager updates, not the safety or coverage of target-app runtime adapters. The updater does not fix the pre-existing external Node dependency or other fresh-machine release blockers. Existing manager logic skips refresh of active generated helpers and stores the extension library outside the manager bundle; actual preservation through a Sparkle update still requires the release transition test above.

References used to validate current Sparkle behavior: [Sparkle setup and feed signing](https://sparkle-project.org/documentation/), [Sparkle settings](https://sparkle-project.org/documentation/customization/), and [manual signing of embedded helpers](https://sparkle-project.org/documentation/sandboxing/). Upstream public headers and the locally resolved Sparkle package were also inspected.
