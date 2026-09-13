# Archived review checkpoints through build 4

This is the preserved earlier review-index text, captured before the build 11 product proofs and actual-manager updater trial. Its current-state language refers to those earlier checkpoints. It is historical evidence, not the current release status or a new review. See the [current review index](README.md), [coverage table](../../CURRENT-COVERAGE.md) and [current implementation/evidence](full-css-js-release.md).

---

# Release readiness — 13 September 2026

**Current decision: NO-GO for general release.** Several original blockers have since been fixed and tested. The eight original NO-GO reports below are historical review snapshots, not eight fresh verdicts on the corrected build. DMG/installer presentation was excluded.

**Latest release direction:** the user stopped the 50-app sweep and explicitly requires full CSS **and JavaScript** support; a CSS-only preview was declined. The sweep remains stopped. Work on library recovery, attributed diagnostics and an owned-fixture JavaScript lifecycle does not satisfy that release requirement by itself. No binary should be published as a full-support release on the strength of those narrower checks.

The last notarized candidate is **0.1.2, build 3**, signed with Developer ID and accepted by Apple notarization. Its verification reports **226 native Swift tests, one skipped, zero failures**, and **175 Node tests passed**. A [real local Sparkle installation](sparkle-local-install-test.md) replaced a notarized build 2 copy with build 3 and restarted the separate test harness. The installed manager was then opened manually, retained its connected extension state and accepted the live signed HTTPS feed. This does not yet prove production-manager self-restart or general release readiness.

The subsequent development follow-up has **248 native tests executed, one skipped, zero failures**, **192 Node tests passed**, and **nine owned mixed-package renderer checks passed**. It adds [library recovery](library-recovery-fix.md), [runtime-log presentation](javascript-lifecycle-and-logs.md), and the [owned-fixture lifecycle core](fixture-extension-lifecycle.md). The core and fixed package proof do not implement production JS loading. These changes are packaged as local build 4; build 3's notarization and updater-install evidence do not apply to build 4.

## The eight original reviews

| # | Historical independent review | Original verdict | Initial concern and current follow-up |
|---|---|---|---|
| 1 | [Product and app coverage](01-product-coverage.md) | NO-GO | CSS proof-control restrictions, JS execution and incomplete native E2E coverage remain gates. Capability presentation was corrected. |
| 2 | [Lifecycle and Dock](02-lifecycle-and-dock.md) | NO-GO | Interrupted replacement is addressed by recoverable helper transactions; active legacy-helper preservation is also implemented and tested. Broader lifecycle E2E remains open. |
| 3 | [Extension security](03-extension-security.md) | NO-GO | Implicit normal screenshot collection is removed at source with regression tests; new-session retention is bounded. TCP debugger lifecycle and historical-session cleanup remain open. |
| 4 | [Fresh-machine portability](04-portability.md) | NO-GO | Homebrew Node/Python dependencies are replaced by packaged Node/native identity. Relocated signed-package fixture proof passes; another-machine/minimum-OS/Intel evidence remains open. |
| 5 | [UX and accessibility](05-ux-accessibility.md) | NO-GO | Capability/import states, persistent drafts and a keyboard Dock alternative are implemented. Live accessibility/fallback checks and integrated diagnostics remain open. |
| 6 | [Test quality and evidence](06-quality-evidence.md) | NO-GO | Full-suite and build-bound fixture evidence are saved. The accepted 50-app matrix and real update/recovery/clean-machine evidence remain incomplete. |
| 7 | [Updater](07-updater.md) | NO-GO | Signed feed/archive checks, tamper rejection and native UI pass. Notarized build 2→3 installation and harness restart passed; real manager self-restart and wider installer failure cases remain open. |
| 8 | [Operations and recovery](08-operations.md) | NO-GO | Unavailable-app management, new-session retention and library backup/export/restore are implemented. Orphan Dock/uninstall handling and historical-session cleanup remain open. |

These were independent inspections, not eight complete live 50-app test runs. Reports distinguish source findings, previously recorded evidence and tests. Follow-ups below explain which findings were addressed without overwriting that history.

## Implemented fixes

| Area | Change and evidence | Remaining limit |
|---|---|---|
| Screenshot privacy | [Privacy fix](privacy-fix.md): ordinary catalog/ChatGPT sessions no longer capture renderer screenshots; supervised diagnostics require explicit opt-in and have per-session limits. 68 focused tests passed. | Live rebuilt production-session verification is separate; active old helpers retain their previous runtime until normal exit. |
| Session retention | [Ownership-based retention](session-retention.md): new launcher sessions receive markers; launch-time maintenance keeps the newest 10 eligible inactive sessions and expires eligible sessions older than 14 days. | Legacy/manual/active/uncertain sessions are preserved. This is not historical cleanup or a total disk cap. |
| Native process identity | [Native identity fix](native-identity-fix.md): packaged Swift/libproc reader replaces production Python/Command Line Tools dependency. | Other-machine/minimum-OS evidence remains separate. |
| Bundled runtime | [Portability follow-up](runtime-portability-follow-up.md): pinned official Node, native helpers and licence use fixed packaged-relative paths. [Signed-package runtime proof](packaged-runtime-proof.md) passes. | Tested architecture is arm64; no universal/Intel claim. |
| Helper recovery | [Transactional helper updates](helper-recovery-fix.md): staged signing/verification, atomic Contents exchange and durable recovery receipt preserve the alias target. 27 focused tests passed. [Active legacy-helper preservation](runtime-portability-follow-up.md) also passes. | Active/uncertain helpers defer maintenance; full installed-helper lifecycle E2E remains separate. |
| Authoring/import/accessibility | [UX fixes](ux-fixes.md): persistent drafts, upfront capability messages, disabled storage of unsupported JS/mixed packages and a keyboard Finder alternative for Dock installation. | No production JS execution; live accessibility checks and runtime-log production remain open. |
| Missing apps | [Unavailable-app management](unavailable-app-fix.md): saved source remains viewable/copyable and records can be disabled/removed without launcher or Dock operations. | Orphan Dock restoration remains separate; library recovery is recorded below. |
| Library recovery | [Backup/export/restore](library-recovery-fix.md): rotating private last-good snapshot, native panels, disabled restores, preserved originals and refusal while sessions are active or uncertain. Ten focused recovery tests pass; native active-session refusal was observed. | Full successful UI restore in an isolated app profile, orphan Dock recovery and arbitrary concurrent external writes remain separate. |
| JavaScript lifecycle and logs | [Owned renderer core](fixture-extension-lifecycle.md) and [Details log tabs](javascript-lifecycle-and-logs.md): cooperative cleanup, attributed bounded events, strict file reader and fixed mixed-package proof. | No production JS loader or log producer; GUI-import-to-running-script flow is still unimplemented. |

## Updater implemented during this review

Sparkle 2.9.6 is pinned, embedded, and configured with an app-specific Keychain signing key. Daily checks default on; automatic installation is optional in Settings. Feeds and downloads must be signed, downloads are verified before extraction, and profiling/JavaScript release notes are off. The app menu uses Sparkle's native update UI.

The authorized public [update repository](https://github.com/b-nnett/electron-extensions) supplies the configured HTTPS feed. It still contains only the signed empty bootstrap feed; no app archive or project source has been published. Archive/feed preparation and tamper-rejection checks pass. Builds 2 and 3 are Developer ID/notarized candidates. The local installer test consumed a separately signed loopback feed, replaced an intact build 2 copy with the exact signed build 3, and restarted its test harness. Afterwards, the installed manager was opened manually and accepted the public empty HTTPS feed. These are distinct checks, with the [installation proof and limits](sparkle-local-install-test.md) and [update runbook](../../AUTO-UPDATES.md) recording their scope.

The updater reviewer found a mismatch between the release build's SDK-keyed SwiftPM artifact directory and the preparation script's default tools path. That was fixed by recording the actual artifact root in build metadata and resolving the tools from the selected app. A separate default Swift Build test-loader regression was resolved by using the same native backend already required by production builds.

## Gates still open

1. **Product coverage:** full CSS and JavaScript support is the user's release requirement. The user stopped the 50-app native E2E sweep; its missing results remain unknown, not passes, and it is not being resumed. A configured profile is not passed coverage. JavaScript execution, CSS adapters tied to fixed proof controls/routes and Claude's missing product launch route remain unresolved. Historical manual Claude proof does not establish a fresh-install workflow. Support must use the app's available extension/debug interfaces without altering target signing or bypassing disabled protections.
2. **TCP debugger lifecycle and privacy:** establish intended debugger-access lifetime/cleanup for relevant target apps and document trust implications without claiming an unproven compromise. The owned fixture's closed-listener result is not general third-party proof. Verify ordinary rebuilt sessions create no screenshots. Historical/manual diagnostic files still need an explicit cleanup/migration decision; new retention does not retroactively own them.
3. **Remaining update and recovery:** signed/notarized older-to-newer installation and separate-harness restart now pass, followed by a manual launch of the updated manager with unchanged library/Dock state and the existing ChatGPT session connected. Still verify the production manager's own updater-driven quit/relaunch, active/inactive helper transitions, cancellation, offline service, unwritable/translocated installation and supported rollback. The local installer used the exact signed archive over loopback, not a public GitHub download.
4. **Fresh-machine portability:** test the final artifact without checkout, Homebrew, Xcode or Command Line Tools on another supported account/machine and the minimum advertised macOS. Same-machine relocation closes the inspected path dependency but does not establish fresh-machine or Intel/universal support.
5. **Data recovery and lifecycle UX:** library backup/export/restore is now implemented and tested with isolated data; the native live refusal while a managed app is active also passes. Verify a successful native restore in an isolated profile and implement deliberate orphan Dock/uninstall handling. The [recovery guide](../../RECOVERY.md) documents behavior and remaining limits. Complete keyboard/VoiceOver and actual Dock fallback checks and connect real attributed runtime-log production to Details. Preserve active or uncertain processes/data when ownership cannot be identified.

These remaining gates prevent declaring the general-release product ready. They are separate from DMG packaging and from the original findings that the follow-up changes have addressed.

## Evidence and scope

Build 2 (**0.1.1**) and build 3 (**0.1.2**) are Developer ID candidates with Apple **Accepted** results: [build 2 notarization](../../../output/release-review/2026-09-13/notarization/build-2/status.json), [build 3 notarization](../../../output/release-review/2026-09-13/notarization/build-3/status.json). These supersede the earlier ad hoc-only state. SDK metadata remains macOS 27/minimum 14.

Build 3 verification:

- [Final native suite](../../../output/release-review/2026-09-13/final-native-tests.log): **226 tests executed, one skipped, zero failures**.
- [Final Node suite](../../../output/release-review/2026-09-13/final-node-tests.log): **175 passed, zero failures**.
- [Focused runtime suite](../../../output/release-review/2026-09-13/final-runtime-tests.log): **20 passed**, including all nine new active-helper/native-resource tests.
- [Build 3 update archive verification](../../../output/release-review/2026-09-13/update-build-3/verification.json): `developmentTest: false`, exact archive hash, verified feed/archive signatures. Its `publishable` flag describes artifact checks, not product approval.
- [Build-bound packaged runtime proof](packaged-runtime-proof.md): relocated signed builds 2/3 passed the owned fixture's CSS apply/disable/re-enable and graceful cleanup with unchanged fixture signing. This does not represent the 50-app matrix.
- [Local Sparkle installation](sparkle-local-install-test.md): exact build 2→3 replacement, verified signature/hash and separate-harness restart. The first receipt's reconstruction is explicitly documented; no invented UI click trace is claimed.
- [Manual launch after installation](../../../output/release-review/2026-09-13/manager-after-update-verification.json): user library bytes, Dock entries and ChatGPT process unchanged; two extensions connected. [Updated native window](../../../output/release-review/2026-09-13/updated-manager.png), [Settings](../../../output/release-review/2026-09-13/updated-manager-settings.png), and [live signed-feed alert](../../../output/release-review/2026-09-13/updated-manager-live-feed.png).
- [Build 3 provenance](../../../output/release-review/2026-09-13/build-3-provenance.json) records source and executable hashes, SDK metadata, notarization and archive verification.

The earlier [verification.json](verification.json) records the 170-Swift/157-Node ad hoc/empty-feed milestone. [Earlier archive verification](updater-artifact-verification.json), [tamper rejection](updater-tamper-verification.json), [native alert](updater-live-feed.png) and [Settings](updater-settings.png) remain evidence of those specific checks. Use the newer logs above for the current candidate; historical hashes must not be relabelled as build 3 evidence.

At completion of the build 3 update test, the user library was unchanged (SHA256 `05de5b42293b3e02b3d3e75ef24670ec69a3e0f4577ef7683193e375335d6413`), Dock entries matched their pre-test hash, and ChatGPT PID 71009 retained its original start time. Packaged-runtime proofs used a new temporary library and the owned Style Lab fixture. That follow-up did not launch/probe the 50 third-party apps or change their signing. The test server is stopped and the executed harness was archived and removed from its launchable location.

The later [build 4 follow-up result](../../../output/release-review/2026-09-13/full-js-followup-result.json) records final source/executable hashes, tests, the fixed-package proof and native UI evidence. Build 4 is Developer ID signed and open locally from `dist/Extensions Anywhere.app`, but has not been submitted for notarization or published. Its final checks again confirm the same user-library bytes and ChatGPT PID/start time; no Dock action was performed. The [native suite](../../../output/release-review/2026-09-13/full-js-followup-native-final-3.log) has 248 executed, one skipped, zero failures; the [Node suite](../../../output/release-review/2026-09-13/full-js-followup-node-final.log) has 192 passes. The [nine-check renderer proof](../../../output/release-review/2026-09-13/fixture-javascript-35b44022-c4c9-4cda-9613-9cc2bf69cd75/report.json) uses the same lifecycle core hash bundled in build 4. It still does not prove production imported-JS support.
