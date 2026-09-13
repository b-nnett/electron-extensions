# Saved extensions for unavailable apps

Implemented 13 September 2026 as a bounded follow-up to operations review 8.

## Behavior

Saved extension identities with no matching discovered installation remain under **Your Apps**, with a **Not installed** subtitle. The sidebar still has exactly the requested Your Apps and Other Apps sections. Selecting the row opens a saved-extension page with a disabled Open App button, a Refresh Apps action, source viewing/copying, and disable/remove controls.

The unavailable row is a separate `UnavailableApp` model containing only the saved key and a display name. It is never an `InstalledApp`, has no URL, and cannot be passed to a launcher. A name remembered from a successful scan is used when available; on a fresh launch with no known installation name, the exact saved key is shown instead of inventing a name or installation path. See `macos/Sources/AppLibraryStore.swift:6` and `macos/Sources/ExtensionsAnywhereApp.swift:91`.

Selection follows an installed app into its unavailable row after a successful refresh detects removal. A matching bundle identity reappearing returns that selection to the real discovered installation. A different identity at the same path does not claim the saved extensions. Removing the final saved record removes only that unavailable row. See `macos/Sources/AppLibraryStore.swift:118`.

The saved-source sheet displays each original CSS/JavaScript source as selectable, read-only text and copies only on the user's Copy Source action. It does not evaluate source. Enabling and launching are unavailable; an enabled saved preference may only be switched off. Existing enabled preferences are preserved when an app disappears, so users can choose whether to keep them for reinstallation. See `macos/Sources/UnavailableAppExtensionsView.swift:4` and `macos/Sources/UnavailableAppExtensionsView.swift:110`.

## Storage and ownership

`disableSavedRecord` and `removeSavedRecord` re-read the library, reject stale record snapshots, stage the requested change, compare the original bounded library bytes, and save atomically. They do not prepare a launcher, enable source, change receipts, open an app, or access Dock preferences. They preserve unrelated records and original source files. The existing installed-app launch and target identity validation remain unchanged. See `macos/Sources/ExtensionManager.swift:87`.

This change deliberately does **not** restore an orphan Dock shortcut. The page explains that saved-record removal leaves existing Dock shortcuts unchanged. Receipt-based orphan restoration and a complete uninstall workflow remain separate operations work. This also does not add library backup/export recovery; Copy Source provides recovery of individual saved files only.

## Verification

Six temporary-model tests were added:

- `AppLibraryStoreTests.swift:151`: disappearance preserves saved identity, name and selection; an unrelated installed row remains unchanged.
- `AppLibraryStoreTests.swift:177`: an unrelated bundle identity cannot claim the row; matching reinstallation restores the real installed row and selection.
- `AppLibraryStoreTests.swift:209`: removing the final record prunes only its missing-app row.
- `ExtensionManagerTests.swift:119`: a temporary app bundle is removed, then its stored extension is disabled and removed; unrelated source and records remain identical, and no launcher/receipt directories or Dock/open/fallback actions occur.
- `ExtensionManagerTests.swift:150`: stale snapshots cannot overwrite externally changed stored source.
- `ExtensionManagerTests.swift:166`: corrupt library bytes are preserved and both recovery mutations fail.

`xcrun swiftc -parse` passed for all six changed/new source and test files. The root agent then confirmed that all six added tests passed in the combined 216-test native suite; its later final-candidate suite completed 226 tests with one opt-in live test skipped. The root release verification owns those complete test logs. No second concurrent build was started by this subagent. No live user library, Dock preference, target app, or saved source was modified during this implementation. Live UI rendering of the unavailable state was not independently exercised by this subagent.
