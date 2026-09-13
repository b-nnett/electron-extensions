# Release UX fixes

Implemented 2026-09-13 by `release_05_ux` after the independent review. This supplements the initial snapshot review in `05-ux-accessibility.md`.

## Changes

- `CreateExtensionView.swift`: unfinished authoring text, selected project folder, target app and whether the creator was open are persisted immediately in `~/Library/Application Support/Extensions Anywhere/authoring-draft.json`. `AppWindow` restores the creator route after an ordinary relaunch or updater relaunch. Leaving the creator preserves its text while recording that it should not reopen automatically.
- Draft snapshots use atomic writes, 0600 file permissions, a 64 KiB UTF-8 brief limit and a bounded 256 KiB JSON read. Corrupt/oversized existing snapshots remain intact. Write failures remain visible in the creator, retain the draft in memory, and tell the user to copy their instructions. Shortening an oversized brief or correcting a transient write failure permits a later save.
- Added `ExtensionCapabilities.swift`. The selected app's actual `ElectronLaunchProfile` and the launcher's existing enabled-record validator determine displayed availability, JS rejection and the combined enabled-CSS size limit. There is no additional injection or runtime implementation.
- The app page, authoring page and import sheet explain CSS-only execution or the absence of a configured runtime before users import. A configured profile is explicitly distinguished from verified compatibility with an installed version.
- The import sheet offers **Save Disabled** for source the selected app cannot run, including JS/mixed packages, oversized aggregate CSS, and apps without a runtime. `ExtensionManager.add(package:app:isEnabled:)` keeps its previous default and adds an explicit disabled-import option. All authored JS/CSS bytes remain in the library and the original package remains untouched.
- Card and details toggles explain unavailable execution and prevent switching such a disabled record on. A previously enabled record can still be turned off. The card says **Cannot run** rather than implying that an unavailable extension is executing.
- Copied authoring instructions now reflect the selected current profile, distinguish package-storage limits from the 64 KiB total enabled runtime-CSS limit, and no longer claim that only the original two profiles exist. They retain read-only source investigation guidance and do not claim unperformed verification.
- The Dock fallback provides **Show in Finder** with the keyboard instruction **⌃⇧⌘T** and an accessibility hint spelling out the keys. Choosing it reveals the exact shortcut, closes the popup and uses the existing close handler to restore Dock auto-hide. This uses the native Finder action documented in [Apple's VoiceOver guide](https://support.apple.com/en-ca/guide/voiceover/vo2695/mac). The drag path and launcher/Dock transactions are unchanged.

## Validation

Command:

```sh
npm run test:macos -- --filter 'AuthoringDraftTests|ExtensionCapabilitiesTests|AuthoringInstructionsTests|ExtensionManagerTests'
```

**15 tests passed, zero failures**, native SwiftPM build complete. Full output: `docs/release-review/2026-09-13/ux-fixes-tests.log`.

The root agent subsequently ran the [final combined native suite](../../../output/release-review/2026-09-13/final-native-tests.log): **226 tests executed, one skipped, zero failures**. This supersedes the earlier pending full-build status without turning synthetic draft/capability tests into live accessibility evidence.

Ten new tests cover draft round-trip including Unicode, target/folder/open route and private file permissions; retaining a closed draft; preserving corrupt/oversized files; UTF-8 save bounds and recovery; visible write failure and recovery; current catalog instructions; moved-app unavailability; existing enabled aggregate CSS limits; CSS alongside stored disabled JS; and mixed-package disabled import with exact source preservation and no launch/Dock writes in the isolated fixture.

The first focused run caught FileHandle's alternate missing-file error representation on a fresh draft. Initialization now recognizes both Cocoa missing-file codes and POSIX ENOENT. The passing log is from the corrected implementation.

Tests use isolated temporary directories and a fake Dock preference backend. This agent did not launch a third-party app, change user extensions, write the real Dock, modify target app signing, or run the updater. The root agent owns the subsequent full build and live app inspection.

## Remaining limits

- No fresh VoiceOver, keyboard-only UI or Finder shortcut E2E run was performed here. The alternative is implemented using the documented native path, but live focus/layout verification remains necessary.
- Runtime logs are still separate from the extension sheet's library activity. The initial review's diagnostics integration finding remains open.
- The shared operation-error alert title and competing Dock error/fallback presentations remain open.
- This fixes misleading capability presentation; it does not expand runtime support or prove compatibility for all discovered apps.
