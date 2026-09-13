# Library backup, export and explicit recovery

Implemented for the release follow-up on 2026-09-13. The operational instructions are in [Recovery and saved data](../../RECOVERY.md).

## Scope and preservation behavior

- `macos/Sources/ExtensionLibrary.swift:182` adds an explicit version 1 library schema with support for existing unversioned libraries. Unsupported versions and unknown top-level fields are rejected. Before a changed valid library is committed, `save` at line 239 preserves the previous exact bytes in `library.last-good.json`. Corrupt/unsupported current data cannot replace that backup. First saves and ephemeral previously absent staging files do not produce orphan backup sidecars.
- `macos/Sources/LibraryRecovery.swift:23` provides bounded, private atomic file replacement. It uses a new `0600` temporary file in an owned directory, synchronizes file contents and renames the directory entry. Linked or multiply linked destination files, nonregular files, changed parent identity, and both direct and resolved paths into `.app` bundles are refused. All library reads remain bounded at 64 MiB.
- `macos/Sources/LibraryRecovery.swift:99` exports validated exact current bytes to a separately selected file. Exports retain enabled preferences, sources and metadata. The live file and last-good snapshot cannot be chosen as export destinations.
- `macos/Sources/LibraryRecovery.swift:108` creates an immutable validated restore plan. All restored records are disabled, their IDs and source remain intact, and a disabled restore event is appended for records that had been enabled. `restore` at line 118 checks current bytes and session inactivity, preserves the exact current original in a unique `Recovery Backups` filename, then checks again before replacement. The selected backup and automatic last-good snapshot are never rotated during an explicit restore. A failed final check can leave an extra original archive while preserving both live and selected-backup bytes.
- `macos/Sources/LibraryRecovery.swift:138` refuses restoration with a running managed launcher or any recorded session whose broker cannot be confirmed absent. The actual launcher folder key is 64 lowercase hexadecimal characters and runtime status uses an integer `brokerPid`. Ambiguous historical evidence is preserved and named in the error. Bounded directory enumeration stops after 512 entries per directory or 512 inspected sessions; it does not delete or stop anything. The guide gives the deliberate, support-reviewed archival path for confirmed inactive legacy evidence.
- `macos/Sources/LibraryRecoverySettingsSection.swift:5` provides native save/open panels and a native confirmation naming the chosen backup and record count. **Restore Disabled** explicitly replaces the library with every restored record disabled. Source/record reload is local; no launch, helper preparation, Dock mutation or receipt reconciliation is called by this feature. Root wired the section into Settings.

## Verification

`macos/Tests/LibraryRecoveryTests.swift` adds ten temporary-directory tests covering:

1. Exact previous-state backup and `0600` modes, with no staging sidecar or leftover write temporary.
2. Corrupt/unsupported current-file preservation, good-backup preservation, and legacy schema compatibility.
3. Full restore of CSS and JS saved records with stable IDs/source, all disabled, and exact damaged-original archive.
4. Refusal of stale restore plans without changing the new current state.
5. A session appearing at the final check, proving the selected last-good backup is not consumed or overwritten.
6. Active-session and invalid-backup refusal before restore writes.
7. Exact export contents, enabled-state preservation and reserved-file protection.
8. Symlink/hardlink destinations and an outside symlink directory resolving into an owned test `.app`, with original bytes unchanged.
9. A sparse oversized incoming file refused at the read bound.
10. Confirmed-absent versus present/unknown historical broker observations, including malformed/missing/boolean/negative saved PID data, direct session symlinks and custom ancestor symlinks. Standardized macOS `/private/var` and `/var` paths are accepted consistently.

The changed Swift files and tests passed `swiftc -parse`. The final focused native run passed **10 tests, zero failures**, with evidence in [the focused test log](../../../output/release-review/2026-09-13/library-recovery-focused-tests-final.log). An earlier combined run exposed a Foundation `/private/var` versus `/var` comparison issue; consistently normalized comparison plus directory type checks fixed it, and both system-alias acceptance and custom-link rejection are covered. The coordinating root owns the subsequent combined native test run and final build result. Root also exercised the native Restore Backup picker against the currently running managed ChatGPT session: the native alert refused before confirmation/write, with no restore performed. That evidence is saved as `output/release-review/2026-09-13/full-js-followup-restore-refusal.png`. This task performed no real-library writes, Dock actions or live app launches.

## Limits

This is one rotating library snapshot plus deliberate exports and preserved restore originals, not automatic whole-support-folder backup, a merge operation, automatic schema migration, session shutdown, orphan-Dock recovery or global history cleanup. It does not restore preferences or receipts. Legacy ambiguous sessions may require the documented support review before recovery proceeds. Source and tests establish the restore operation in isolated data; a successful native picker/confirmation restore into a temporary app profile remains separate from the live active-session refusal. Filesystem corruption, power-loss durability, arbitrary concurrent external writers and minimum-OS UI operation are not claimed as tested.
