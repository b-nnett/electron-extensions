# Recoverable generated-helper updates

13 September 2026. Follow-up to the helper refresh blocker in [review 02](02-lifecycle-and-dock.md).

Generated launcher updates now build and ad-hoc sign a complete replacement helper in a unique staging directory. Strict signature verification finishes before the installed helper changes. A flushed, bounded recovery receipt records the expected old and new Contents digests before commit. Preparation and background refresh resume pending commits before proceeding.

For an existing helper, the commit uses macOS `renameatx_np(RENAME_SWAP)` to exchange the entire signed `Contents` directories in one filesystem operation. This is deliberate: moving the old `.app` itself into a backup would let a Finder alias follow that original bundle inode into the backup. Keeping the installed `.app` root preserves its inode and alias target while every signed byte inside it changes together. The old Contents remain in the staged bundle until the installed replacement passes strict verification.

Recovery recognizes both sides of the commit: an unchanged old installation plus the verified staged replacement, or the already-committed replacement plus the previous Contents. Unexpected receipt identities, changed installation/staging bytes, and unrecognized helpers are preserved and reported. Active or uncertain helpers defer both installation and recovery. The final process check occurs immediately before the swap. Initial installation uses the same receipt with no invented previous helper and an atomic staged-bundle rename.

The commit receipt is retired after final verification, before best-effort backup deletion. An interruption during that cleanup can leave an unused staging directory, but cannot strand the working helper behind a pending receipt for a partially deleted backup. The receipt plus atomic exchange handle process interruption; a destructive external filesystem change is not silently repaired or discarded, and power-loss/filesystem-corruption recovery was not exercised.

A matching `EALauncherSourceSHA256` alone no longer marks a helper current. Signature and Runtime digest verification are required. An identified, stopped helper with matching metadata but damaged signing, a missing Runtime, or an unexpected Runtime digest is rebuilt from the manager's packaged source. This repairs the specific previous failure window after metadata write but before re-signing. Unchanged helpers avoid a redundant second Runtime hash during background refresh.

Aliases, their bytes, helper configuration, extension data, and Dock preferences are outside this transaction. Root-agent runtime portability changes separately migrate execution to the bundled Node/native identity reader.

## Verification

Command:

```sh
swift test --package-path macos --build-system native --filter 'HelperBundleTransactionTests|ElectronLauncherTests|LauncherRefreshQueueTests'
```

**27 tests passed, zero failures:** ten new helper transaction tests, ten existing ElectronLauncher tests, and seven existing launcher refresh queue tests. [Saved test log](../../../output/release-review/2026-09-13/helper-transaction-tests.log).

New tests use temporary owned bundles containing a copied `/usr/bin/true` executable. Only those copies are signed. They are never launched or registered; no installed target app, real Dock preference, or user extension file was modified. The tests verify:

- Complete signed Contents replacement, unchanged installed bundle inode, unchanged Finder alias bytes, and alias resolution to the installed helper after the swap.
- Recovery after injected interruption immediately after durable receipt save, Contents commit, and installed verification, for both replacement and first install.
- A build/signing failure leaves the previous signed helper intact.
- Deferral for an already-active helper, a helper that starts during staging, and an active helper during receipt recovery.
- Preservation of unexpected changed stage/installation contents and a receipt attempting to name another bundle.
- Detection and repair of current metadata with an invalid signature, and current metadata with a valid signature but wrong Runtime digest.

The native SwiftPM backend is required by this checkout's existing test command because the default Swift 6.4 backend did not embed the newly added transitive Sparkle framework for XCTest. The native-backend run loaded it normally. No claim is made here about installed-helper live replacement, literal Dock clicking, real interruption by SIGKILL, or an end-to-end Sparkle update.
