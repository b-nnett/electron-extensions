# Recovery and saved data

This guide describes the current Extensions Anywhere app. **Settings → Extension library** provides **Export Library…** and **Restore Backup…**. Normal changes to an existing valid library preserve its previous state in `library.last-good.json`. This is one rotating library snapshot, not a complete system backup. A signed application update does not separately back up preferences, receipts or Dock changes. There is no global Clear History button or automatic uninstall workflow.

## Stop or restart a managed session

1. Save work in the target app. To stop using a tweak while keeping that app open, select it in Extensions Anywhere and disable the extension. On a connected supported runtime, wait for the updated appearance; disabling the last extension reports that the stylesheets were removed. A saved toggle alone does not prove that a disconnected app has changed.
2. To end the session, use the target app's own **Quit** command and complete or cancel its normal save dialogs. Allow its managed launcher and broker to finish. Do not force-quit a process merely because its name resembles the app or a launcher.
3. Reopen through Extensions Anywhere's **Open App**, its menu-bar launch item, or its managed Dock shortcut when you want extensions again. If a clean restart is required, the native alert offers **Restart** and **Not Now**. Confirm Restart only when ready to quit the target normally.

The missing-extensions prompt is enabled by default in **Settings → Launching apps**. Turning that preference off suppresses automatic prompts; it does not disable extensions or stop an existing session. A healthy existing connection can simply activate the app instead of restarting it.

Closing the Extensions Anywhere window leaves its menu-bar service running. Quitting the manager stops its monitoring, but it is not a **Stop All Sessions** action: generated launchers are separate processes and can outlive it. A target app reopened directly after a vendor update may start without extensions; use the normal restart flow. If an updated target is incompatible, keep its extensions disabled and use its ordinary app icon until that version is supported.

For a failed or stuck session, preserve its latest report before retrying. **More → Show Session Logs** opens the recorded session directory when available. A process name, stale PID, or old `status.json` is insufficient to choose a process to terminate. If ordinary Quit does not finish, ask support to identify the exact managed launcher/broker and current process identity before taking further action. There is no Stop Session toolbar button in the current app.

## Remove extensions, including when the app is missing

For an installed app, open an extension's **Details**, select **Remove Extension**, and confirm. Its original imported files remain on disk. Disable rather than remove if you want to keep the saved source and metadata. Removing or disabling the final enabled extension attempts the scoped Dock restoration described below.

Saved records for an app that is no longer installed remain under **Your Apps**, marked **Not installed**. The row may show the saved bundle identifier when its original display name is unavailable. Select it to:

- Use **View Source**, choose each source file, and use **Copy Source** to recover that file's saved text. This does not export an entire manifest package; use **Settings → Extension library → Export Library…** to preserve all records and metadata.
- Turn off **Saved as enabled** or confirm **Remove Extension**.
- Use **Refresh Apps** after reinstalling the matching app.

The missing-app page cannot enable source, launch an app, or add a Dock shortcut. Disabling/removing there changes saved records only and leaves existing Dock shortcuts and receipts unchanged. Enabled preferences are retained when an app disappears, so disable them before reinstallation if you do not want them used again. A matching installed identity restores the ordinary app row; an unrelated app at the same path does not claim those records.

## Recover a Dock shortcut

For an installed target, disabling/removing its last enabled extension restores the exact original pin if Extensions Anywhere replaced one, or removes only the pin it added. Recovery checks the receipt's owned GUID, URLs, and expected tile against the current Dock. Moving an unchanged owned pin is supported; renaming, repointing, duplicating, or removing it can cause a conflict. The saved disabled preference remains disabled even when Dock recovery fails.

If a conflict appears, preserve the receipt and inspect the current Dock before retrying. **Add to Dock** installs a shortcut; it is not a general Restore Dock or orphan-recovery command. A pin dragged manually through the floating panel is not automatically adopted into programmatic ownership.

Automatic restoration of a missing app's orphan shortcut is not implemented. For an explicit manual recovery:

1. Stop the relevant session, back up the receipt, and record the current Dock arrangement. Identify the receipt whose target URL is the intended app and whose replacement URL is its generated alias/helper under the support folder.
2. Use Finder and the Dock item's **Options → Show in Finder**, where available, to verify which file that specific pin resolves to. Compare the resolved alias/helper with the saved receipt. Similar app names or icons are not sufficient. If the match is uncertain, leave the pin alone and ask support to inspect the receipt and current tile.
3. Once verified, remove that specific shortcut through the Dock's normal **Remove from Dock** action. If the original target is installed and you want a normal pin, drag its actual app bundle from Finder into the Dock. If the target is missing, wait until it is reinstalled.

Manual Dock edits do not reconcile Extensions Anywhere's receipt state. Keep the receipt as evidence; a later Add to Dock may still need scoped support recovery. Do not alter receipt GUIDs, fabricate an original tile, delete receipts to bypass a conflict, or restore an entire old `com.apple.dock` preference domain over unrelated current pins.

The floating drag panel temporarily reveals an auto-hidden Dock. Closing the panel restores its owned auto-hide setting immediately; while it stays open, picking up its icon starts the ten-second restoration deadline. Normal manager quit also attempts restoration, and startup recovers a valid receipt after interruption. If that recovery cannot be verified, preserve `DockVisibility/receipt.json` and use macOS's Dock settings to choose your desired auto-hide value explicitly. Do not erase the receipt first and lose the original setting record.

## Back up before an update or recovery

While the library is healthy, choose **Settings → Extension library → Export Library…**, then choose a separate file outside the live support folder. The native save panel lets you choose its location. An export includes all saved source, record IDs, metadata, enabled preferences and library activity. It does not include original package folders, app preferences, Dock receipts, generated launchers or session logs. Export reads a validated snapshot and does not require stopping a session; prepare a complete support-folder backup as below before a larger recovery or update.

Before a normal committed library change, the app validates the existing file and saves those exact previous bytes to `library.last-good.json`, then atomically writes the new library. If the backup cannot be saved, the normal change is refused. A first save has no prior state to back up, and saving unchanged bytes does not rotate the backup. Corrupt data or an unsupported library schema never replaces the good snapshot. New library, backup, archive and export files are created with owner-only `0600` permissions; keep exported copies in storage you control. The app does not automatically restore a backup.

Save target-app work, end managed sessions normally, close the drag panel, and quit Extensions Anywhere. Keep the backup outside the live support folder, with a date and the installed app version/build. Do not relocate or delete active session folders while copying data.

In Finder, use **Go → Go to Folder** and copy the entire folder:

`~/Library/Application Support/Extensions Anywhere/`

Its contents can include:

| Item | Purpose |
|---|---|
| `library.json` | Saved source, extension names/descriptions, enabled preferences, IDs, and library activity. |
| `library.last-good.json` | The previous valid state saved before a normal library change, if one exists. |
| `Recovery Backups/` | Unique copies of the original library preserved during explicit restore attempts; these can include malformed originals. |
| `authoring-draft.json` | The saved Create Extension draft. |
| `extensions.json` | Earlier sidebar assignments, if present. |
| `DockReceipts/` | Per-app pin ownership and original/replacement tile records. |
| `DockVisibility/receipt.json` | Temporary auto-hide recovery, when present. |
| `Launchers/` | Generated aliases/helpers, their configuration, session pointers and diagnostic folders. |
| `runtime-events.json` | Bounded lifecycle metadata used for diagnosis. |

Also preserve the **`dev.extensions-anywhere.app`** macOS preferences domain. It contains restart-prompt and usage preferences, and Sparkle maintains update preferences in that app domain. Its backing file is normally `~/Library/Preferences/dev.extensions-anywhere.app.plist`; macOS caches preferences, so use the standard **defaults export** operation for that exact domain after the app has quit when an authoritative export is needed. Have support perform or review the export if you are unfamiliar with that tool. Keep a reference export of **`com.apple.dock`** only when investigating Dock recovery; it is not a file to restore wholesale.

Keep original extension folders and their manifests too. Imported source is copied into the library, but recovering individual source text is not the same as preserving the original package layout. Backups and older session captures can contain private source or app content; keep them in storage you control and share only the relevant reviewed files with support.

## A malformed library or a backup restore

The app validates loaded records and refuses to overwrite a malformed library with an empty value. Current reads and writes are bounded at 64 MiB. New saves use `schemaVersion: 1`; the original unversioned format remains readable. An unsupported version or an unknown top-level schema field is refused, rather than silently discarded. A load error preserves data and blocks normal changes; **Restore Backup…** remains available for an explicit recovery.

1. Save work and quit managed target apps normally. Wait for their launchers and brokers to finish. Keep a separate copy of the failing library and the support-folder backup, and retain the exact error message.
2. In Extensions Anywhere, choose **Settings → Extension library → Restore Backup…**. Select your exported library or `library.last-good.json` in the native open panel. The app checks the selected file using its library decoder; valid JSON syntax alone is insufficient. Invalid, oversized, unreadable or symbolic-link source files are refused. Do not assume a newer schema can be read by an older app.
3. Review the native confirmation, which names the selected file and record count. Choose **Restore Disabled** only when you intend to replace the entire current library. Every restored extension will be disabled, including those enabled in the backup. This is a replacement, not a merge.
4. The app preserves the exact existing `library.json` bytes, including a malformed original, in a unique `Recovery Backups/library-before-restore-<UUID>.json` file before replacement. It leaves `library.last-good.json` and the selected source unchanged. It checks again for changed current bytes or active/uncertain sessions before committing. A late refusal can leave an additional preserved-original archive, but does not consume the chosen backup.
5. Inspect the restored records and source. Re-enable only the extensions you want and use the ordinary app launch flow. Restore itself does not launch apps, prepare helpers or change Dock shortcuts. The Settings result shows the preserved-original path.

Restore is refused while a managed launcher is running. It also checks historical session directories under `Launchers/<64-character app key>/Sessions/<UUID>/`. Only a positive numeric `brokerPid` whose process is confirmed absent is accepted as inactive by this conservative recovery check. A missing or malformed status, a PID that is currently present (possibly reused), unknown process state, linked directory, unexpected launcher key or an inspection bound can block recovery. The alert names the evidence path. Closing the manager alone does not resolve that state.

For an ambiguous historical folder, leave it in place until support has reviewed it. Save the named folder, its status/report/ownership marker if present, and the surrounding launcher configuration in a separate dated backup. Stop all managed sessions normally. Support must establish that the exact recorded session has ended, using current process identity and any available executable/start-time/owner evidence; a matching name or saved PID is not sufficient. Only after that verification and your explicit choice may that specific inactive diagnostic folder be moved to a preserved archive outside `Launchers`, allowing the scan to proceed. Keep the archive, do not change status PIDs to pass the check, and do not move helpers, receipts or active/unidentified data. If inactivity cannot be established, restore remains blocked. There is no automatic "clear stale sessions" action.

If the current library itself exceeds the read bound, is linked, has unsafe ownership or cannot be read, preserved or safely replaced, restore refuses without replacing it. Preserve the original outside the live folder and ask support to validate a duplicate and review the file state. A manual replacement remains a separate explicit recovery action after stopping sessions and quitting the manager; it is not an instruction to delete the failing file or relax validation.

Restoring the library does not restore process state, reload runtime source into an active app, or reconcile old Dock receipts against today's Dock. Preferences require their own deliberate, reviewed restore while the app is closed. Keep current receipts and generated helpers unless a separate ownership review establishes what to restore; copying an old support folder over a live one is not a general rollback procedure. Never edit a target app bundle or change its signature to recover a tweak.

For a manager-version regression, prefer a corrected signed update with a higher build number. Replacing it with an older executable is not a supported data-migration guarantee. Release operators should follow [Automatic updates](AUTO-UPDATES.md) for the signed release/rollback process and preserve the pre-update data backup independently.

## Session retention and legacy diagnostic files

The updated ChatGPT and catalog runtimes do not capture screenshots during ordinary launches. Explicit diagnostic runs can capture complete visible renderer content and have a per-session capture limit. The owned Style Lab verification broker still produces its intended test screenshots. An already-running older helper keeps its older runtime until it stops and is refreshed; an app update does not retroactively change that session's capture behavior.

New generated-launcher sessions receive an ownership marker named **`.ea-session-owner.json`**. At a subsequent session start for the same launcher, maintenance checks marked older sessions. It can remove eligible sessions older than **14 days** or beyond the **10 newest eligible inactive sessions**, but only after verifying that both recorded owner processes have ended and that filesystem identities and contents remain valid. It excludes the current session and does not stop processes to make them eligible.

Unmarked legacy folders, live sessions, unknown process identities, invalid markers, unexpected files, and oversized/uninspectable trees are preserved. A session-root scan beyond its 512-entry bound also preserves data instead of attempting a broad deletion. These safeguards mean the policy is **not a hard disk-usage cap**. A copied marker is not an authorization to delete a folder: its recorded filesystem identity may no longer match.

There is no global Clear History button. To remove legacy diagnostic data, first stop the exact related session, preserve anything needed for support, identify that specific inactive session directory, and explicitly remove only those reviewed diagnostic files/folders. Do not bulk-delete the support folder, alter markers to make old data eligible, or discard Dock recovery receipts as if they were logs. Automatic retention never claims to have erased all historical screenshots.

## Remove Extensions Anywhere itself

Disable/remove the desired extensions and verify the owned Dock pins are restored or manually recovered before removing the manager. End target sessions normally, confirm the relevant helpers/brokers have stopped, close the drag panel, and quit the manager. Then remove the installed Extensions Anywhere app through Finder.

Keep the support-folder backup. Remove its remaining saved data only through a separate explicit choice after verifying that no retained managed pin or running helper depends on it. Deleting the manager alone does not stop a running target, remove generated helpers, restore the Dock, or erase your library. Original target apps and original imported extension files should remain untouched.

Implementation references: [Dock launching](DOCK-LAUNCHING.md), [missing-app management](release-review/2026-09-13/unavailable-app-fix.md), [library recovery implementation](release-review/2026-09-13/library-recovery-fix.md), [packaged-runtime verification](release-review/2026-09-13/packaged-runtime-proof.md). These instructions document the current behavior; they do not claim that every recovery scenario has received live end-to-end verification.
