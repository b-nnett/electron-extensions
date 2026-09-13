# Release review 8 — operations and recovery

Date: 13 September 2026. Reviewer: independent operations subagent. Scope excludes DMG/installer polish. **Verdict: NO-GO for a general public release.** An opt-in developer preview is a different release decision, but should still remove the automatic screenshot behavior described below.

Follow-up: the original findings below are the review-time snapshot. Current operating and recovery instructions are in [Recovery and saved data](../../RECOVERY.md); implemented missing-app management and its remaining Dock limits are documented in [the focused fix](unavailable-app-fix.md). [Library backup/export/recovery](library-recovery-fix.md) now addresses the library-recovery implementation finding. Consult the final release assessment for validation and resolved versus outstanding findings.

This review independently inspected persistence, runtime evidence collection, Dock recovery, UI access to saved data, dependency packaging, and existing recovery tests. The concurrent Sparkle implementation and its signing/publishing verification are owned by review 7; an updater integration is not treated as proof of a completed production update and rollback exercise.

## Findings

### P1 — Routine extension launches capture and retain complete third-party app contents

The production catalog broker always captures before/styled screenshots when applying CSS, then captures restoration screenshots. See `scripts/dock-catalog-session.mjs:233`, `scripts/dock-catalog-session.mjs:245`, and `scripts/dock-catalog-session.mjs:270`. Despite accepting a `clip` parameter, `lib/catalog-stylesheet.mjs:245` captures the complete visible renderer at line 256. The ChatGPT broker also captures the complete visible renderer when its voice extension is active: `scripts/dock-chatgpt-session.mjs:146`, `scripts/dock-chatgpt-session.mjs:164`, and `scripts/dock-chatgpt-session.mjs:178`.

This is runtime code actually copied into the app, not just the separate E2E runner: `scripts/lib/package-runtime.mjs:4` and `scripts/lib/package-runtime.mjs:39`. Neither ordinary launcher arguments nor Settings provide screenshot consent or a diagnostics opt-in (`macos/Launcher/LauncherMain.swift:152`; `macos/Sources/SettingsView.swift:8`). The user requested screenshots during development, but that does not constitute a future customer's agreement to retain their messages, documents, or editor contents every time a tweak applies.

Every launch creates a new UUID session directory and replaces only the latest-session pointer (`macos/Launcher/LauncherMain.swift:141`). No cross-session pruning or user-facing clear-history action exists in the reviewed launcher, manager, or Settings. Per-image and per-session revision limits do not cap cumulative disk use. Session files use restrictive permissions, which is useful protection but does not remove the retention problem.

**Release acceptance:** ordinary launches and toggles must create no screenshots; retain visual evidence in the explicit verification workflow or a clearly opted-in diagnostic session. Define an age/size/count retention policy for diagnostics, exclude live sessions and recovery receipts from pruning, and offer a clear-history action. On an owned fixture, prove that routine launch/toggle/restart produces no PNGs and that opted-in captures and pruning obey the documented bounds. A screenshot failure must not prevent an otherwise valid stylesheet from running.

### P2 — Saved extensions and Dock recovery become inaccessible after an app is removed

The sidebar's Your Apps list is derived only from currently discovered installations (`macos/Sources/AppLibraryStore.swift:57`); an app removed from `/Applications` disappears even when its extension records and managed Dock receipt remain. There is no separate saved-library management route. Records can be removed only through an installed app's detail sheet (`macos/Sources/ExtensionDetailsSheet.swift:95`).

Even a caller retaining the old app model cannot finish normal Dock reconciliation after removing or disabling its last extension: the disabled path calls `validateSelectedApp` before `dock.restore` (`macos/Sources/ElectronLauncher.swift:567`), and validation requires the installed app to still be discoverable (`macos/Sources/ElectronLauncher.swift:588`). That is appropriate for launching code, but couples restoring an owned Dock tile to a target that may no longer exist.

The app also has no uninstall/recovery instructions explaining how to stop its helpers, restore only its owned Dock changes, and optionally remove its own saved data. Application termination restores temporary Dock visibility only (`macos/Sources/DockInstallWindow.swift:313`); it is not an uninstall operation. This finding does not request automatic deletion of user data on quit.

**Release acceptance:** allow users to inspect, export, disable, and remove saved records for missing installations; restore/remove only a verified owned Dock pin using its receipt without requiring the target bundle to be launchable. Document safe removal of the manager, helpers, preferences, and optional library/history. Exercise a controlled app being moved or removed, plus an externally edited Dock pin, and preserve unrelated pins and source files.

### P2 — Corruption protection exists, but no usable library recovery or upgrade backup exists

The library is a single JSON file (`macos/Sources/ExtensionLibrary.swift:191`). Save validates the existing file and writes atomically (`macos/Sources/ExtensionLibrary.swift:209`); malformed data is preserved instead of replaced with an empty library. `macos/Tests/ExtensionLibraryTests.swift:80` explicitly covers this safeguard. However, a load failure simply sets an error and blocks mutation (`macos/Sources/ExtensionManager.swift:38`, `macos/Sources/ExtensionManager.swift:48`). There is no last-known-good backup, export/restore path, or documented recovery procedure.

The persisted library has no top-level schema version (`macos/Sources/ExtensionLibrary.swift:181`). Compatibility with the earlier single-source record format is covered by `macos/Tests/ExtensionManifestTests.swift:104`; that is positive evidence for this specific transition, not a general future upgrade/downgrade contract. The rollback process should preserve the library, Dock receipts, and helper runtime state, rather than assume replacing the app bundle alone reverses an update.

**Release acceptance:** provide a recovery procedure that preserves the damaged original, exports usable saved data, and restores a validated backup. Define a library schema/compatibility policy before shipping automatic updates that might change it. Use isolated profiles to prove an old-to-new upgrade retains IDs, source text, enabled choices, and receipts, and a supported rollback either reads the new data safely or restores the backed-up compatible state. Do not advertise corruption protection as automatic recovery.

## Positive evidence and non-blockers

- Extension source text is copied into the library; normal removal preserves original input files. Mutations re-read current state, compare the original bytes before saving, and preserve saved preferences when a separate Dock operation fails (`macos/Sources/ExtensionManager.swift:148`).
- Library activity and the separate runtime event journal are bounded at 500 entries. The journal's metadata intentionally omits source, documents, and debugger URLs and is saved with mode `0600` (`macos/Sources/RuntimeEventJournal.swift:3`, `macos/Sources/RuntimeEventJournal.swift:31`). This bounded journal should be the basis for routine support data instead of full app screenshots.
- Dock receipts accept versions 1 and 2 and record ownership. Restoration targets the currently owned tile instead of rolling back the whole Dock (`macos/Sources/DockShortcut.swift:130`, `macos/Sources/DockShortcut.swift:214`). Temporary visibility has a startup recovery receipt (`macos/Sources/DockVisibility.swift:110`, `macos/Sources/DockVisibility.swift:135`).
- The current packaged `ws` dependency includes its `LICENSE`: the complete dependency directory is copied at `scripts/lib/package-runtime.mjs:43`, and the license was present in both the checkout and built app. I did not find evidence that its notice is being stripped. Final Sparkle and any future bundled Node notices need checking against the final release artifact; absence of a repository-wide app license is not itself asserted to be a redistribution violation.
- The extension detail sheet accurately labels its logs as library activity and provides copying (`macos/Sources/ExtensionDetailsSheet.swift:57`, `macos/Sources/ExtensionDetailsSheet.swift:109`). Runtime logs are separately reachable from the app toolbar. A polished diagnostic exporter would help support, but is not independently declared a release blocker.

## Validation limits and release gate

This was a source and artifact inspection. I did not run production app actions, read saved app screenshots or documents, change the user's library or Dock, perform an uninstall, or exercise a live update. Existing test sources were inspected; no new test pass is claimed. File references reflect the reviewed workspace; the concurrent updater work may add lines to Settings and build files.

Release clearance requires the P1 capture/retention behavior to be removed or gated, documented and verified missing-app/data recovery, and the separate updater review's production update/rollback evidence. The report does not certify third-party target-app updates: fixed identities and runtime checks reduce incorrect launch risk, but compatibility after a vendor update still needs the coverage review and a safe failure/recovery path.
