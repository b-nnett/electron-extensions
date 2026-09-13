# Automatic updates

Sparkle 2.9.6 is pinned in `macos/Package.swift` and `macos/Package.resolved`. The manager embeds Sparkle, starts its standard updater once at application launch, and exposes **Extensions Anywhere → Check for Updates…** and an **Updates** section in Settings.

Daily background checks default on. Automatic download/installation defaults off; users can enable it in Settings. Preferences use Sparkle's own persisted values and KVO, so its dialogs and Settings agree. Profiling and JavaScript in release notes are disabled. Only Extensions Anywhere updates itself; installed target apps are outside this update operation.

## Published host

- Repository: https://github.com/b-nnett/electron-extensions
- Feed: https://github.com/b-nnett/electron-extensions/releases/latest/download/appcast.xml
- Initial release: https://github.com/b-nnett/electron-extensions/releases/tag/updates-bootstrap

Release **0.1.14/build 15** uses this public repository and the normal signed Latest feed. Its [ZIP](https://github.com/b-nnett/electron-extensions/releases/download/v0.1.14/Extensions-Anywhere-0.1.14-15.zip) and [appcast](https://github.com/b-nnett/electron-extensions/releases/download/v0.1.14/appcast.xml) are bound to tag `v0.1.14`. The initial `updates-bootstrap` release supplied an empty feed before the first app release. A separate [updater-test prerelease](https://github.com/b-nnett/electron-extensions/releases/tag/updater-e2e-20260913) contains the reviewed build 11 archive and signed test feed. It is not Latest or a production app release. The [actual manager 3→11 trial](release-review/2026-09-13/real-manager-self-update.md) has now passed download, replacement and self-relaunch.

`macos/UpdateConfiguration.json` holds the repository, HTTPS URL, public Ed25519 key, and Keychain account `dev.extensions-anywhere.app`. The private key was generated with Sparkle's official `generate_keys` and remains in the login Keychain. Never commit/export it into the repository, app, appcast, logs, or a hosting server. Keep an encrypted offline backup using the official key-management procedure before distributing builds: loss of this key matters because feed verification has no timeout fallback and archives are verified before extraction. Key rotation has additional requirements; read Sparkle's documentation before rotating.

## Build and sign

The regular `npm run build:macos` remains an ad hoc development build. The custom packager copies Sparkle with `ditto` to preserve symlinks, signs its nested XPC services and updater helpers from the inside out, embeds the license, and verifies the final bundle deeply and strictly. Our native helpers are signed **before** the runtime manifest hashes their bytes. The SDK metadata guard remains in place to preserve the native Liquid Glass appearance.

For a release candidate, use an available Developer ID Application certificate and a new numeric version/build:

```sh
EA_SIGN_IDENTITY='Developer ID Application: Nyne Apps LTD. (X522N436T7)' \
EA_VERSION=0.1.1 EA_BUILD_NUMBER=2 npm run build:macos:release
```

`CFBundleVersion` must increase across every release. A rollback is a new, higher build containing the corrected older behavior; never lower the build number. The command above is an example, not a claim that build 2 was released. The current release artifact is 0.1.14/build 15.

Release builds require Developer ID and enable hardened runtime/timestamps. The app now bundles a checksum-pinned official Node 24.21.0 executable and a native process-identity reader. End users do not need Homebrew, Python, Xcode, or Command Line Tools for those runtime dependencies. The currently verified artifact is **Apple silicon**, with a macOS 14 deployment minimum; minimum-OS and clean-machine testing remain separate gates.

The notarization profile **`nyneapps`** was restored and validated in this Mac's Keychain on 13 September after an earlier missing-profile error. It uses the existing **Extensions Anywhere Notary** App Store Connect team key from protected signing storage outside the checkout; submission history and a new Apple Accepted submission confirm it works. No private key contents were read or exported. Do not put keys or exported credentials in Git, CI logs or the app bundle. Another build Mac needs its own provisioned credentials; this local profile is not GitHub Actions configuration.

Notarize a frozen, signed app copy, then staple the accepted ticket before preparing the final update archive:

```sh
ditto -c -k --keepParent '/absolute/path/Extensions Anywhere.app' /absolute/path/notarization.zip
xcrun notarytool submit /absolute/path/notarization.zip --keychain-profile nyneapps --output-format json
# Query the returned submission UUID until Apple reports Accepted.
xcrun notarytool info SUBMISSION_UUID --keychain-profile nyneapps --output-format json
xcrun notarytool log SUBMISSION_UUID --keychain-profile nyneapps /absolute/path/apple-notary-log.json
xcrun stapler staple '/absolute/path/Extensions Anywhere.app'
spctl --assess --type execute --verbose=4 '/absolute/path/Extensions Anywhere.app'
```

Do not change sealed files after signing. Archive the submission response, Apple log, stapler output, and Gatekeeper result with that exact build. DMG design is optional; code authenticity and an actual installation test are release gates.

## Prepare a reviewable update

```sh
npm run prepare:update -- --output /absolute/path/to/empty-release-directory
```

The command reads the built app's version and Sparkle-tools location from its metadata, checks identity and update configuration, verifies the bundle signature and Gatekeeper acceptance, checks that the Keychain signing key matches the public key embedded in the app, then creates a ZIP and signed appcast. It independently verifies the ZIP against the shipped public key and verifies the feed using Sparkle. Output must be empty, so previous artifacts are not overwritten. Nothing is uploaded. `--app` selects an explicit manager build and `--tools` allows a relocated build machine to select the pinned Sparkle tools.

`--development-test` bypasses the Gatekeeper gate only for local signing tests. Its `verification.json` is marked `developmentTest: true, publishable: false`. Never upload these artifacts to the production feed. This switch is confined to the offline preparation tool; the installed updater still requires signed feeds and archives.

For each production release, publish the ZIP and `appcast.xml` together in the GitHub release tagged `v<CFBundleShortVersionString>`. The generated archive URL targets that exact tag. Keep older release assets immutable. Draft releases are suitable for reviewing the assets before publication; their private download URLs cannot be used to prove an ordinary user's update check. Promote the approved stable release to **Latest** so the configured feed URL resolves to its appcast. Do not mark an unverified development build latest. The current one-archive preparation supports full updates and disables deltas.

Before promotion, compare the new build number with the last published feed. Archive `verification.json`, the exact app/build hashes, signed appcast, test logs, and notarization results with the release evidence. The script's artifact checks do not constitute product approval.

## Verification on 13 September 2026

The final release artifact is **0.1.14/build 15**. Apple accepted submission `6030c18d-2bf5-4b9a-8d80-d4cb3c430ced`; stapling, Gatekeeper and deep/strict signing passed. The prepared production ZIP and signed feed both verify, with archive SHA-256 `2f8075caf9f9c4efb0768cd3fd420e066f7ee690a1aa6aab3fef6a0ffe547906`. Final source checks passed 260 Node tests and 301 native tests with five live opt-ins skipped, zero failures; the separate final Figma product trial passed 22 checks. The earlier update-installation evidence below remains tied to builds 3→11.

- Manager and embedded framework build, launch, and pass deep/strict signing verification; manager SDK metadata stays 27 with deployment minimum 14.
- The native application menu and update Settings appear. Automatic-check preference toggles correctly, disables automatic-download controls when off, and was restored on.
- The signed feed is publicly reachable over HTTPS. Downloaded bytes match the staged feed and Sparkle verifies its signature.
- A real **Check for Updates…** call accepted that feed and displayed Sparkle's native “You're up to date” alert.
- A local development ZIP and generated feed both verify. Changing one archive byte or modifying feed content makes verification fail.
- The original updater checkpoint passed 226 native tests (one live opt-in skipped) and 175 Node tests. The latest native source checkpoint passed 301 tests (five live opt-ins skipped); the latest Node checkpoint passed 260 tests, zero failures. Build 11’s earlier 242-test result remains a separate checkpoint. The earlier six-test authoring rerun is not added to the unique count. These counts do not represent extra live updater trials. The native SwiftPM test backend is explicit because the default Swift 6.4 backend failed to locate the transitive Sparkle framework in the test bundle.
- Apple accepted Developer ID builds **0.1.1 (2)** and **0.1.2 (3)**. Both tickets were stapled, and Gatekeeper reports **Notarized Developer ID**. Submission IDs: `eb46389c-f3fc-4f81-b455-bee1c653b4af` and `6170b07f-3635-4b47-b3d3-d160137dc427`.
- Build 3's final ZIP and appcast were prepared with the normal Gatekeeper requirement, and both Ed25519 signatures verified. No development-test bypass was used. These artifacts have not been published.
- Exact build 3 passed the [relocated packaged-runtime test](release-review/2026-09-13/packaged-runtime-proof.md), including apply/disable/reenable/restoration and unchanged owned-fixture signing with a system-only PATH.
- A [real local Sparkle installation](release-review/2026-09-13/sparkle-local-install-test.md) replaced an intact notarized build 2 copy with the exact build 3 archive and restarted a separate harness. The updated manager was then opened manually, its saved/connected extension state checked, and its native updater accepted the live signed empty HTTPS feed. Library/Dock bytes and the existing ChatGPT process were unchanged. The harness used a signed loopback feed; that historical harness did not establish production-manager self-restart or public archive delivery. The later actual manager trial below established both.
- The lower real manager was prepared from build 3's production code and existing update key, with only its copied signed Info.plist feed pointing at the exact separate prerelease URL. Apple accepted submission `97a47800-240a-4619-8c8a-7cb4e3d85ebf`; stapling, Gatekeeper and strict signature checks passed. Its immutable preparation receipts remain separate from the later live result.
- Build 11's separate test-prerelease ZIP and appcast were anonymously downloaded after publication. Their hashes match the reviewed assets and their Ed25519 signatures verify. Latest remained `updates-bootstrap`, and the production feed stayed signed and empty.
- **The actual manager 3→11 self-update passed.** Native Check for Updates offered 0.1.10; after Install Update, the user confirmed the normal Install and Relaunch prompt while CUA timed out. The operator instructed that final click and subsequently observed a fresh build 11 manager process at the same path without issuing a manual open command. Expected executable hash, deep/strict signature, staple and Gatekeeper checks passed. Its functioning UI showed two enabled ChatGPT extensions and Connected status. [Complete result](release-review/2026-09-13/real-manager-self-update.md).
- Library bytes, Dock, restart/update choices and existing ChatGPT/helper/broker identities were unchanged. The authoring draft was absent before and after. Usage history was retained, with ChatGPT's count advancing 161→162 and its last-used time advancing during the interactive test. This difference was preserved and recorded; no claim of byte-identical preferences or clean-account verification is made.

Local evidence is under `output/updater/2026-09-13`; durable review conclusions and selected logs are under `docs/release-review/2026-09-13`. The user's extension library hash remained unchanged and the existing ChatGPT process was not restarted by this work.

## Actual manager self-update test

The completed test used the lower **real manager**, a higher signed/notarized candidate and the separate public prerelease tag `updater-e2e-20260913`. The test feed and archive used the existing update key; the normal Latest feed stayed unchanged. The lower copy's feed was set before signing, because the manager intentionally clears user-default feed overrides.

This test uses the existing macOS account and the actual manager's preferences and library. Snapshot those states privately before launching the lower copy; no library fixture or reset is required. Use the manager's native **Check for Updates…** and Sparkle Install/Relaunch flow, then observe a fresh process at the same installed path with the higher build's expected signature/hash. Compare saved library/draft and stable preference choices, allowing legitimate Sparkle last-check bookkeeping. Do not manually reopen the manager to manufacture relaunch evidence or restore a stale whole preference domain. Record the first completed result once. The [concrete plan and prepared paths](release-review/2026-09-13/real-manager-self-update.md) distinguish this test from the earlier split-bundle harness.

The current source includes configured CSS/JS engines; live app coverage is recorded separately in the [coverage table](CURRENT-COVERAGE.md). This updater result establishes manager replacement and the specific state-preservation checks on this Mac, not new third-party app compatibility or a clean-account result.

References: [Sparkle setup and signing](https://sparkle-project.org/documentation/), [SwiftUI integration](https://sparkle-project.org/documentation/programmatic-setup/), [settings and security options](https://sparkle-project.org/documentation/customization/), [manual nested-code signing](https://sparkle-project.org/documentation/sandboxing/).
