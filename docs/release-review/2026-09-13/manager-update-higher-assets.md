# Higher candidate assets for the actual-manager update

**Completed on 13 September 2026.** Build 11’s exact ZIP and signed feed were prepared, reviewed, published as the separate updater-test prerelease, anonymously downloaded and verified. The actual manager then passed its 3→11 self-update. See [the complete result and artifact hashes](real-manager-self-update.md). The procedure below records that bounded preparation; its immutable preparation receipt predates publication.

The bounded preparation script is `scripts/testing/prepare-manager-update-assets.mjs`. It accepts only:

```sh
node scripts/testing/prepare-manager-update-assets.mjs --accepted-app "output/release-review/2026-09-13/notarization/build-11/Extensions Anywhere.app"
```

It is fixed to version `0.1.10`, build `11`, the manager identity `dev.extensions-anywhere.app`, Developer ID team `X522N436T7`, and the existing Keychain update-signing account `dev.extensions-anywhere.app`. The lower candidate is bound through the preserved preparation receipt for run `cb137ea0-1972-40ca-ba46-3176731d67c3`, version `0.1.2` / build `3`.

The higher app's `SUFeedURL` remains `https://github.com/b-nnett/electron-extensions/releases/latest/download/appcast.xml`. Only the generated appcast enclosure uses the separate test release prefix `https://github.com/b-nnett/electron-extensions/releases/download/updater-e2e-20260913/`. Both feed and archive use the public key already shipped in the lower and higher apps. No Sparkle channel is added: the prepared lower manager checks the default channel on its separate signed test feed.

The script verifies strict/deep Developer ID signing, the stapled ticket and Gatekeeper acceptance before archiving. It checks the existing public Keychain key using `generate_keys -p`, which does not create or export a private key. The official pinned Sparkle 2.9.6 tools generate and verify one signed appcast and one full ZIP, with no delta. XML inspection verifies the item count, build, version, exact enclosure URL, size and signature. The archive signature is also verified independently against the public key with Node crypto. The extracted app must have exactly the frozen candidate's Info.plist, code signature, executable hash and complete file/symlink/mode fingerprint, while the source remains unchanged.

Each run writes a new private `output/release-review/2026-09-13/manager-update-build11-<UUID>` directory. `Assets` contains only the ZIP and signed appcast. Command logs, extraction verification, hashes and the publication plan live outside `Assets`. Official `generate_appcast` may use its documented `~/Library/Caches/Sparkle_generate_appcast` extraction cache. No user preferences, extension library, Dock data or target app is touched. The script contains no upload, app launch, bundle edit/re-sign or notarization submission action.

After reviewing the generated `verification.json`, the root task separately authorized publication of exactly its two hashed assets to GitHub tag `updater-e2e-20260913`, with `prerelease: true` and `make_latest: false`. An existing tag/release and its assets must be inspected before deciding whether to create or upload; no asset clobbering is part of this preparation. The production Latest feed remains unchanged. After publication, anonymous downloads must match the reviewed feed/archive hashes and pass signature verification before the lower manager is opened for the actual Sparkle update interaction.

Validation completed: Node syntax/help, accepted-artifact checks, generation, independent archive/feed signature checks, public anonymous download verification and actual manager self-update all passed. `verification.json`, `publication.json` and the final update result remain separate receipts. The archive procedure and signing approach follow [Sparkle's official publishing documentation](https://sparkle-project.org/documentation/publishing/); the installed official command help was checked for the exact generation and verification flags.
