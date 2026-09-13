# Native macOS app

A SwiftUI extension library with a native, resizable sidebar. Runs on macOS 14 or later; building requires Swift 6 and a selected macOS 26-or-newer SDK. Open `Package.swift` in Xcode to work on the native sources.

From the repository root:

```sh
npm run start:macos  # Build and open the app
npm run build:macos  # Build dist/Extensions Anywhere.app
npm run test:macos   # Native models, manifest validation, and scoped Dock tests
```

The manager includes Sparkle updates with native **Check for Updates…** and Settings controls. The actual manager **3→11 self-update passed**, including replacement and self-relaunch with saved library/Dock and restart/update choices preserved; one usage activation was recorded. Release 0.1.14/build 15 uses the normal signed production feed; the earlier updater-test prerelease remains a separate test artifact. See [automatic updates](../docs/AUTO-UPDATES.md) and the [current coverage table](../docs/CURRENT-COVERAGE.md).

The packaging script explicitly selects the current Xcode SDK and SwiftPM's `native` build backend. It keeps the deployment minimum at macOS 14 and checks every executable's Mach-O SDK metadata before packaging. This prevents the Swift 6.4 default build-backend regression observed on 13 September, where a fresh build with SDK 27 incorrectly recorded SDK 14 and SwiftUI reverted to the older system appearance. Build caches are separated by compiler/SDK identity; `Contents/Resources/BuildEnvironment.json` records the actual toolchain and verified executable metadata. No system appearance setting is changed.

Every discovered app, including ChatGPT, offers **Open App** and **Add to Dock**, with or without extensions. Apps without a runtime profile get a real Finder alias pointing directly to their original `.app`; opening it launches the app normally. This path executes no extension source or debugging flags. We sign our manager, separate helpers and owned fixture; target bundles and signing remain unchanged.

For any discovered app, enabling an extension prepares its alias and replaces an existing target pin or adds one managed pin. Disabling or removing the last enabled extension restores the replaced original, or removes only the managed addition. Explicit **Add to Dock** also works with no enabled extensions. Version 2 receipts store the owned GUID and an original tile only when one existed; version 1 replacement receipts remain readable. Unrelated Dock tiles and user changes are preserved, and ownership conflicts do not undo saved extension preferences.

Configured runtime profiles use alias → separately signed launcher → CSS/JS broker. The manager bundles the official Node runtime, native process-identity helper, broker modules, `ws` and catalog. Generated helpers copy the verified runtime into their own `Contents/Resources/Runtime`, with fixed executable/resource paths inside the signed helper. End users do not need Homebrew or a source checkout. Node/npm is needed to build from source. The [relocated packaged-runtime proof](../docs/release-review/2026-09-13/packaged-runtime-proof.md) and later Style Lab/VS Code mixed product runs verify their specific packaged paths. Apps without a runtime profile can retain disabled source. See [Dock launching](../docs/DOCK-LAUNCHING.md).

The current source configures CSS + renderer JavaScript for all **47 catalog profiles**, plus built-in Style Lab, experimental ChatGPT and assisted Claude. Exact application identities and launch arguments remain checked. Slack, Notion and Figma allow paths on their exact configured HTTPS origins; other routes remain profile-specific. Style Lab passed 22 native product checks, VS Code 1.137.0 passed 19, and Figma 126.8.18's login page passed 22 with final build 15. Ordinary Figma disable preserved the app; explicit helper/pipe closure ended it normally. Its files browser/editor routes are configured but unverified. ChatGPT has earlier live CSS evidence, while its new main-page JS and the other 45 catalog profiles are not newly live-verified. Claude 1.52386.6 passed 25 native product checks with build 13 on its exact new-chat page, with user-enabled debugger setup required after each launch. See the [coverage table](../docs/CURRENT-COVERAGE.md) and [Claude setup](../docs/CLAUDE-SETUP.md).

## Add to Dock and drag fallback

The selected-app top toolbar's **More** menu offers **Add to Dock** even when its extension list is empty. This single action attempts programmatic installation and opens the drag fallback if installation fails. Explicit addition pins independently of enabled records, and failures retain the saved enabled preference. Repeated programmatic addition recognizes an existing owned pin.

The fallback is a compact, borderless 480 × 164-point floating panel, placed 12 points above the bottom Dock (or beside a side Dock). The horizontal icon and instructions are vertically centered. It has no traffic lights or Done button; a custom top-right Close (×) button, Escape, or Command-W dismisses it. Its instructions describe ordinary app launching for generic shortcuts and extension launching for configured runtime profiles. Placement follows fresh screen work-area bounds briefly after Dock is revealed and stops adjusting on window movement or icon pickup. Dragging exports the real Finder alias. The panel records matching canonical alias/resolved-target positions at pickup, then checks through a three-second deadline after an accepted drag. It closes only for a newly added or moved matching entry. An unchanged already-pinned entry, a cancelled drag, or a drop elsewhere without a matching Dock change leaves it open. Presentation identity, per-drag UUIDs, and poll cancellation prevent stale callbacks from closing a reopened panel. A manually dropped pin is not automatically adopted into a programmatic ownership receipt.

If auto-hide was explicitly enabled, showing the panel temporarily reveals Dock. Icon pickup starts a ten-second restoration timer while the panel stays open; another pickup resets it. Closing always cancels that timer and restores auto-hide immediately, including after pickup or an automatically confirmed drop. Normal quit restores the owned setting, and next startup recovers a receipt left by a crash or interruption. Auto-hide already off or unset is left alone. The separate recovery file is `~/Library/Application Support/Extensions Anywhere/DockVisibility/receipt.json`.

Live programmatic addition, removal of only the owned pin, final re-addition, and preservation of unrelated pins passed. [Recorded result](../output/dock-install/2026-09-06T16-33-30Z/result.json). The compact implementation passed all **48 Swift tests at 17:50:54 on 6 September 2026**, and the release build succeeded. [Test log](../output/dock-install/compact-panel/swift-tests.log), [build log](../output/dock-install/compact-panel/build.log). A historical manager-driven live Dock check, predating immediate restoration on close, passed: auto-hide remained off at 9.826 seconds and restored by 10.576 seconds after simulated pickup, despite simulated panel closure. [Visibility result](../output/dock-install/compact-panel/live-visibility.json). A real fallback Dock drop and automatic closure after that drop remain unverified; the UI automation could not drag from the floating panel. These results also do not establish a literal Dock-click launch or third-party launch profiles.

## App library

- **Your Apps:** discovered apps with at least one assigned extension ID.
- **Other Apps:** all remaining discovered apps.
- Discovery starts in `/Applications`, includes ordinary subfolders, and checks each app for its bundled Electron framework. ChatGPT is an explicit discovery exception, identified by `com.openai.codex` and executable `ChatGPT`; this inclusion does not enable a runtime adapter or assert its architecture. It stops at app packages so nested helpers do not become rows. App symlinks are resolved and deduplicated; directory symlinks are not followed.
- Names match localized Finder names. Icons come from `NSWorkspace`.
- The library refreshes when the window becomes active or with **View → Refresh Apps** / **⌘R**. **⌘S** toggles the sidebar.
- The selected-app top toolbar shows **Open App** and the **More** menu containing Dock actions, alongside the app's icon and name. The info button opens a native About-style sheet with version, build, Electron version, bundle ID, location, and a filesystem-based date added. Date added is labelled with its source; it is not asserted to be the original installation date.
- **Add Extension** reads a JSON manifest for its name, description, version, and CSS/JS sources. It supports multiple files and validates the package before import. See the [manifest format](../docs/EXTENSION-FORMAT.md).
- **Create Extension** stays pinned in the sidebar's bottom safe-area inset. **Create your own** in the import sheet opens that page too. Shared copied/task instructions include the selected bundle and candidate `app.asar` paths, require read-only renderer-source inspection with version/path references and selector assumptions, and request extension files only. Extract archives only from a copy outside the installed app; use equivalent renderer assets when absent. It detects installed Codex, Claude, and Cursor task links. Documented links open drafts; they do not automatically submit them.
- Card toggles save the desired enabled state. Selecting a card opens details and real library activity logs. Removal asks for confirmation and keeps the original source file.
- Configured profiles show runtime status and selected-app capability text before import/enable. Details separates attributed Runtime logs from Library activity. Enabled limits are 64 KiB CSS and 256 KiB JavaScript, at most 64 enabled records and 32 files per record. Profiles without a configured runtime cannot run stored source; engine configuration alone is not a compatibility result. See [package format and lifecycle](../docs/EXTENSION-FORMAT.md).

The extension records, source copies, enable settings, and bounded activity history are persisted atomically in:

```text
~/Library/Application Support/Extensions Anywhere/library.json
```

Legacy sidebar assignments are also read from:

```text
~/Library/Application Support/Extensions Anywhere/extensions.json
```

The JSON is a bundle-identifier mapping, ready for the extension manager to populate:

```json
{
  "com.example.app": ["my-stylesheet-extension"]
}
```

A missing file means an empty library. The app does not create demo assignments or treat historical CSS compatibility trials as installed extensions. Invalid persisted data surfaces an error and is preserved.

## Sources

- `Sources/ExtensionsAnywhereApp.swift`: window, sidebar sections, app rows.
- `Sources/AppLibraryStore.swift`: background loading, grouping, selection, and icon cache.
- `Sources/AppLibrary.swift`: filesystem discovery and assignment decoding.
- `Sources/AppExtensionsView.swift`: selected-app page, extension cards, and file import.
- `Sources/AppInformationView.swift`: read-only app metadata and About sheet.
- `Sources/ExtensionDetailsSheet.swift`: extension information and activity logs.
- `Sources/ExtensionManager.swift`: observable UI state and persistence operations.
- `Sources/ExtensionLibrary.swift`: extension records, import validation, atomic storage, and event history.
- `Sources/CreateExtensionView.swift`: manifest instructions, persistent authoring draft, and coding-tool handoff UI.
- `Sources/CodingTools.swift`: installed tool detection and documented deep-link construction.
- `Sources/ElectronLauncher.swift`: ordinary aliases, scoped Dock installation, selected runtime profiles and session status.
- `Shared/RuntimeExtensionSelection.swift`: shared manager/helper record validation, source limits and profile-bound JS capability.
- `Sources/ExtensionRuntimeLogs.swift`: bounded current-session script logs, separate from library activity.
- `Sources/DockShortcut.swift`: scoped Dock preference changes and recovery receipts.
- `Sources/DockInstallWindow.swift`: compact alias drag panel and actual Dock-pin verification.
- `Sources/DockVisibility.swift`: temporary auto-hide changes, timer, and quit/startup recovery.
- `Launcher/LauncherMain.swift`: accessory app that validates and supervises its packaged broker.
- `Tests/DockShortcutTests.swift`: mocked Dock transactions, aliases, conflicts, and restoration.
- `Tests/ElectronLaunchProfileTests.swift`: exact profile identity and selected source-policy checks.
- `Tests/ElectronLauncherTests.swift`: generic alias resolution, stale/changed-target rejection, and injected Dock install/restore checks.
- `Tests/AppLibraryTests.swift`: synthetic app bundles, nested-helper exclusion, symlink handling, and assignment behavior.

The earlier immediate-close and ChatGPT discovery changes passed all 52 native tests, including cancellation of an old timer across popup reopening and strict known-app identity matching. [Test log](../output/dock-install/close-and-chatgpt/swift-tests.log). These results predate generic shortcut support; its live verification is pending.

The immediate-close live check restored the actual Dock auto-hide preference in approximately 69 ms after a simulated pickup and close, cancelled the deadline, and removed its receipt. ChatGPT was verified in the running sidebar. [Close result](../output/dock-install/close-and-chatgpt/live-close.json), [current build](../output/dock-install/close-and-chatgpt/build.log).

Historical generic Dock verification: **64 native tests passed**; real alias preparation/resolution passed for **50/50 generic apps**. ChatGPT’s UI Add to Dock, normal Open App activation, exact original-pin restoration on disable, and reinstallation on enable passed. Its signing and unrelated Dock pins were unchanged. Bruno’s zero-extension Dock controls were verified. That trial left the managed ChatGPT pin installed. These checks cover ordinary Dock launching, not the later runtime profiles. [Live result](../output/dock-all-apps/chatgpt-live-result.json), [alias coverage](../output/dock-all-apps/installed-aliases.json), [tests](../output/dock-all-apps/swift-tests.log), [build](../output/dock-all-apps/build.log).
