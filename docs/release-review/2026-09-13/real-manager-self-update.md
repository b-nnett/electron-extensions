# Real manager self-update proof

**Passed on 13 September 2026:** the actual Extensions Anywhere manager updated from **0.1.2/build 3 to 0.1.10/build 11**, then relaunched itself at the same installed path. No manual open command was issued after the update. This uses the production Sparkle 2.9.6 controller, where both `hostBundle` and `applicationBundle` are `Bundle.main`; the earlier split-bundle harness is separate historical evidence.

## Current result

The [final result](../../../output/release-review/2026-09-13/manager-self-update-cb137ea0-1972-40ca-ba46-3176731d67c3/self-update-result.json) records `passed: true` at `2026-09-13T19:39:50.269309+00:00`. The [state comparison](../../../output/release-review/2026-09-13/manager-self-update-cb137ea0-1972-40ca-ba46-3176731d67c3/state-preservation.json) retains the observed differences rather than resetting them.

| Check | Observed result |
| --- | --- |
| Native update offer | Check for Updates offered 0.1.10 to the running 0.1.2 manager |
| Download and installation | Operator clicked Install Update. When CUA timed out at the next stage, the user confirmed that Install and Relaunch was visible and was instructed to click it |
| Actual self-relaunch | Lower PID 8209 was replaced by fresh PID 9791 at the same Host path; no subsequent manual app launch |
| Installed identity | Build 11, expected CDHash and executable SHA-256; deep/strict signature, stapled ticket and Gatekeeper checks passed |
| Functioning UI | CUA inspected the new manager window with two enabled ChatGPT extensions and Connected status |
| User library and draft | Library bytes/hash unchanged; authoring draft absent before and after |
| Preferences and Dock | Restart-prompt and automatic-update choices unchanged; Dock unchanged |
| Usage history | Preserved, with ChatGPT's count advancing **161 → 162** and last-used time advancing during the interactive test; not byte-identical and never reset |
| Existing managed app | ChatGPT PID 71009, helper 71002 and broker 71003 retained their exact process identities |
| Update feed after installation | Higher build restored its normal production feed; the separate test prerelease remained outside Latest |

This is a real-manager self-update and preservation check on the existing macOS account, not a clean-account trial. It does not claim that every preference byte remained identical, that a populated draft was tested, or that additional third-party app coverage was verified. The final confirmation was user-assisted; no successful CUA click on Install and Relaunch is invented.

## Lower-candidate preparation history

The lower copy was Developer ID signed, Apple Accepted, stapled and Gatekeeper accepted before launch. Its frozen source was notarized version 0.1.2/build 3. It kept the production executable, bundle identifier, public update key, signed-feed requirement and verification-before-extraction requirement. Only the copied `SUFeedURL` changed before re-signing our copied outer bundle with Developer ID team `X522N436T7`. The frozen source and copied runtime resources compared unchanged at preparation.

The first submission attempt found the local `nyneapps` profile missing and created no submission. On 13 September, the user supplied the public Issuer ID; normal `notarytool store-credentials` restored and validated the profile using the existing protected key file as input. No private key contents were read or exported. The same prepared archive was then accepted under submission **`97a47800-240a-4619-8c8a-7cb4e3d85ebf`**. The finish step stapled and validated its ticket, checked Gatekeeper and the final strict signature, and wrote the immutable `ready.json` receipt at `2026-09-13T19:18:16.226Z`.

Run UUID: `cb137ea0-1972-40ca-ba46-3176731d67c3`.

| Artifact | Repository-relative path, home path or value |
| --- | --- |
| Frozen source | `output/release-review/2026-09-13/notarization/build-3/Extensions Anywhere.app` |
| Test installation, now updated to build 11 | `~/Library/Application Support/Extensions Anywhere Native E2E/manager-self-update-cb137ea0-1972-40ca-ba46-3176731d67c3/Host/Extensions Anywhere.app` |
| Evidence directory | `output/release-review/2026-09-13/manager-self-update-cb137ea0-1972-40ca-ba46-3176731d67c3` |
| Preparation record | The evidence directory's `preparation.json` |
| Notarization archive | The evidence directory's `lower-build-3-notarization.zip` |
| Lower candidate CDHash | `79bdc5a939a579b20d317370f7cbd142d0307189` |
| Lower executable SHA-256 | `97767c135446998d5f8fe4dc3384c5e657b07fb8ef9b2f4cbcffafd58ef06d6b` |
| Stapled bundle tree SHA-256 | `00e3a0276237d10efe96ab064904005b83bbdde7356fbcdd24756d3ea34d5790` |
| Completed preparation receipt | The evidence directory's `ready.json` |
| Exact signed test feed | `https://github.com/b-nnett/electron-extensions/releases/download/updater-e2e-20260913/appcast.xml` |

## Higher candidate assets

Version **0.1.10/build 11** was frozen, Apple Accepted (`cd9e4437-a2b1-43dd-814e-347b00132239`), stapled and Gatekeeper accepted. `scripts/testing/prepare-manager-update-assets.mjs` prepared its exact test-tag ZIP/appcast without changing the app, launching it or uploading anything. Its Info.plist retains the normal production feed.

Evidence directory: `output/release-review/2026-09-13/manager-update-build11-07101f89-727c-4f40-95ad-abdff2723941`. The immutable preparation `verification.json` records the publication plan before upload. The later `publication.json` records the public delivery check before manager installation; the final self-update result above records the subsequently completed round trip.

| Asset under `Assets/` | Bytes | SHA-256 |
| --- | --- | --- |
| `Extensions-Anywhere-0.1.10-11.zip` | 42,117,802 | `c992fdfcebd5d457dbcdc339d7ac882d6f557ea14d308f98839d4fb3848831df` |
| `appcast.xml` | 1,318 | `8433c183281422032bfd3d2b1cabcd0d138c6eb85c883b4083b9da37ce6a05c8` |

The feed has one full enclosure at the exact prerelease tag, with no Sparkle channel or delta. Feed and archive signatures validate against the existing lower manager's key. An extracted copy has the frozen app's exact Info.plist, tree hash, executable hash and signature; its stapled ticket and Gatekeeper acceptance also validate. Frozen build 11 remains unchanged. Its CDHash is `dcb4dd3fa66144ff633e18ceaf7cb4f98dc1b099`; executable SHA-256 is `74fbcc45990c4f27ec6a9c9b36d59096a7ae2bded65657bda8dfbafac26d7dff`.

The reviewed assets were published at the separate [updater-test prerelease](https://github.com/b-nnett/electron-extensions/releases/tag/updater-e2e-20260913), title **Updater verification — build 11**, at `2026-09-13T19:27:25.842Z`. Both the tag and release were absent before creation; nothing was overwritten. Anonymous HTTPS downloads matched both hashes above, and downloaded feed/archive signatures validated. Latest remained `updates-bootstrap`; its actual production feed remained signed and empty with SHA-256 `42da7ea5ef61c879dd631c8c7ea85519097207d36cedac202fd200099f86527d`.

These asset checks establish public test delivery; the later result above establishes actual installation and manager quit/relaunch. The test prerelease makes no Claude or complete-compatibility claim.

## Preparation tool

`scripts/testing/prepare-manager-self-update.mjs` accepts only a new preparation, `--submit RUN_UUID`, or `--finish RUN_UUID`. It fixes the source, feed, app identity, signing team and directory class; creates fresh UUID directories; refuses reused output; preserves command logs; checks source/resource hashes and bundle signatures; and submits through the `nyneapps` Keychain profile. It never invokes a manager executable or changes preferences, the extension library, release hosting or third-party apps.

The completed preparation used these resume commands after restoring the profile. They are recorded for reproduction; do not rerun this finished UUID:

```sh
node scripts/testing/prepare-manager-self-update.mjs --submit cb137ea0-1972-40ca-ba46-3176731d67c3
node scripts/testing/prepare-manager-self-update.mjs --finish cb137ea0-1972-40ca-ba46-3176731d67c3
```

The finish step records Apple's status. Only `Accepted` permits stapling, ticket validation and Gatekeeper assessment. The immutable `ready.json` records preparation-time hashes and the then-unlaunched state; it remains historical and is not overwritten by the later live result. Node syntax checking, copy/sign/identity/hash verification, Apple notarization, stapling and Gatekeeper checks passed.

## Recorded round-trip procedure

1. Prepare the next higher candidate with its normal production feed unchanged, Developer ID sign/notarize/staple it, and retain immutable expected bundle/hash metadata. Create its full ZIP and an appcast using the same existing update signing key. The enclosure must use the exact `updater-e2e-20260913` tag URL. The normal `prepare-update.mjs` hardcodes a `v<version>` download prefix, so this test feed must be generated with the official `generate_appcast --download-url-prefix` pointing at the exact test tag and then signature-verified. Do not edit XML after signing.
2. Publish only those reviewed assets on the separate public GitHub prerelease tag `updater-e2e-20260913`, explicitly not Latest. A draft cannot provide ordinary anonymous update downloads. GitHub's prerelease marker is sufficient; do not add a Sparkle `<sparkle:channel>` that the production updater has not opted into. Verify anonymously downloaded feed/archive bytes and signatures. The production `releases/latest/download/appcast.xml` remains unchanged.
3. Quit any existing **manager** normally. Before opening the prepared lower manager, privately snapshot the existing library/draft and stable application preferences. This uses the real `dev.extensions-anywhere.app` preference domain and `~/Library/Application Support/Extensions Anywhere`; it is not an isolated or clean macOS account. No library fixture or reset is needed for this proof.
4. Open the lower manager at the exact prepared path and record its live PID/start identity, path, build and signature. Use its existing **Check for Updates…** action and Sparkle's normal Install/Relaunch UI. Let Sparkle perform the quit and relaunch. Observe the new manager process without manually launching it to manufacture restart evidence. Verify the same installed path now has the higher build's expected signature/executable hash, a fresh process identity, a functioning window and the loaded saved extension state.
5. Compare existing library content, authoring draft (if present), restart-prompt setting, most-used data and automatic-update preference choices before/after. Record absent optional state as absent; do not invent a populated draft. Sparkle's last-check metadata and first-launch bookkeeping may legitimately change, and `AppUpdater.start()` deliberately clears obsolete `SUFeedURL` defaults. Do not overwrite the whole preference domain or restore stale values to force a match. Save the first successful result once, alongside the actual UI/process observations.

The executed procedure establishes manager download, replacement, normal quit/relaunch and the specific preservation results above. It does not imply a clean-account test or broader third-party extension coverage. The prior signed-copy/harness result remains historical evidence and is not relabeled as this test.

The archive/signing sequence follows Sparkle's [publishing documentation](https://sparkle-project.org/documentation/publishing/). Product source references: `macos/Sources/AppUpdater.swift`, `macos/Sources/ExtensionLibrary.swift`, `macos/Sources/AppPreferences.swift`, `macos/Sources/CreateExtensionView.swift`, and `scripts/lib/update-settings.mjs`. The copied signed Info.plist owns the test feed because `AppUpdater.start()` clears user-default feed overrides; no runtime updater override or application-bundle substitution is used.
