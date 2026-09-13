# Extensions Anywhere 0.1.14

Extensions Anywhere adds CSS stylesheets and JavaScript to supported desktop app renderers through a native macOS manager, without changing the target apps’ installed bundles or signatures.

- Import a JSON extension package, enable it per app and launch through a managed shortcut. Add that shortcut to the Dock or use the menu bar’s tweaked-app list.
- Write scripts with attributed console logs and explicit cleanup for disable, replacement and page reload. View Runtime logs separately from library activity.
- Use native restart alerts, configurable restart reminders, saved authoring drafts, and library backup/export/restore.
- Receive signed updates through Sparkle. The actual manager 3→11 download, replacement and self-relaunch passed, preserving library data and stable settings.

CSS and renderer JavaScript are configured for 47 catalog profiles plus Style Lab, experimental ChatGPT and assisted Claude. Full product lifecycle proofs exist for Style Lab, VS Code 1.137.0, Figma 126.8.18’s login page and Claude 1.52386.6’s new-chat page. Figma passed 22 checks with this build, including startup readiness, real clicks, disable/re-enable, replacement, native reload and cleanup. Claude passed 25 checks with manager build 13, including real clicks, rapid re-enable, replacement, native reload and cleanup. Its debugger must be enabled through Claude’s own menu after each launch.

Figma’s signed-in files/editor routes, the other 45 catalog apps and ChatGPT’s new JS path are configured but not newly live-verified. See the [coverage table](https://github.com/b-nnett/electron-extensions/blob/v0.1.14/docs/CURRENT-COVERAGE.md) and [Claude setup](https://github.com/b-nnett/electron-extensions/blob/v0.1.14/docs/CLAUDE-SETUP.md) for exact scope and instructions.

The packaged runtime is self-contained on Apple silicon. The deployment minimum is macOS 14; live evidence is from Apple silicon on macOS 27, not every supported OS version or Intel. The extension format does not provide Chrome extension APIs. Compatibility depends on the app version and selected renderer; cleanup is cooperative and cannot undo arbitrary external side effects.
