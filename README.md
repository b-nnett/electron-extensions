# Extensions Anywhere

A native macOS app for adding CSS and JavaScript to supported app renderers without modifying their installed bundles or signatures.

**Release 0.1.14/build 15 — 13 September 2026:** [Download for Apple silicon](https://github.com/b-nnett/electron-extensions/releases/download/v0.1.14/Extensions-Anywhere-0.1.14-15.zip) · [Release notes](https://github.com/b-nnett/electron-extensions/releases/tag/v0.1.14). Developer ID signed, notarized and Gatekeeper accepted. CSS and JavaScript are configured for the 47 catalog profiles, plus the built-in Style Lab, experimental ChatGPT and assisted Claude profiles. Complete native product proofs exist for Style Lab, VS Code, Figma’s login page and Claude’s new-chat page. Configuration alone is not verification of an installed app, its current version, or every window.

## What works today

| App or scope | Current implementation and evidence |
| --- | --- |
| **Style Lab**, our owned Electron fixture | Imported CSS + JS, click handlers, attributed logs, disable/re-enable, source replacement and automatic reload. Native product runs passed **22 checks** on builds 5, 6 and 7. [Proof](docs/release-review/2026-09-13/javascript-lifecycle-and-logs.md#build-5-native-product-proof). |
| **Visual Studio Code 1.137.0**, packaged workbench | Imported CSS + JS passed **19 native product checks** with manager build 9: a real green button and click handler, logs, cleanup, replacement and normal VS Code reload. Target signing and bundle contents stayed unchanged. [Evidence and reproduction](docs/release-review/2026-09-13/native-vscode-product-proof.md). |
| **Figma 126.8.18 login page** | **22 native product checks passed** with manager build 15: CSS, real JS clicks, logs, disable/re-enable, replacement, native reload and cleanup. Ordinary disable preserves Figma; explicit helper/pipe closure ended the test app normally. The current origin-scoped profile also permits files/editor routes; those routes remain unverified. [Proof](docs/release-review/2026-09-13/native-figma-product-proof.md). |
| **Other 45 catalog profiles** | CSS + renderer JS is configured for each existing profile's routes and launch method. No new live JS product passes are claimed for these apps. |
| **ChatGPT main app page** | Experimental CSS + JS is configured and covered by source tests. Earlier live CSS application/disable/re-enable evidence remains valid for that run; **JS has not been verified in the installed app**, and no host restart was performed for this change. |
| **Claude** | **25 native product checks passed** on Claude 1.52386.6 with manager build 13: CSS, real JS clicks/logs, rapid re-enable, replacement, native reload and cleanup with unchanged signing. Requires its user-enabled debugger after each launch, on the exact new-chat page. [Proof](docs/release-review/2026-09-13/native-claude-product-proof.md) · [Setup](docs/CLAUDE-SETUP.md). |

See the [current coverage table](docs/CURRENT-COVERAGE.md) for the app list and scope, and the [CSS + JS implementation notes](docs/release-review/2026-09-13/full-css-js-release.md) for evidence. The separate 50-app sweep was stopped at the user's request; its skipped or unfinished results remain unverified. The [eight original release reviews](docs/release-review/2026-09-13/README.md) retain their dated findings and follow-ups.

## Use the manager

1. Select an app under **Your Apps** or **Other Apps**. Rows use installed app icons; **⌘S** toggles the sidebar.
2. Choose **Add Extension** and select a JSON manifest. The manifest supplies the name, description, version and CSS/JS files. Unsupported packages can be **saved disabled** without discarding their source.
3. Enable an extension and use **Open App**. Configured apps use a separate signed launcher with the required launch flags. An already-running app normally offers a native **Restart / Not Now** alert; restart requires choosing Restart. Claude instead uses its verified running process and waits for its [manual debugger setup](docs/CLAUDE-SETUP.md).
4. Open extension details for **Runtime** console output and separate **Library** activity. A saved enabled preference is not a successful connection; the app page shows runtime status.
5. Use the toolbar's **More → Add to Dock** for the managed launcher. The same action provides a drag fallback when needed.

Every discovered app has ordinary Open App and Dock actions, including apps without an extension runtime. Those actions alone do not make extensions executable. Settings controls the default-on prompt for apps running without extensions. The menu bar launches tweaked apps and groups larger collections into **Most Used** and **All Tweaked Apps**.

**Create Extension** stays at the bottom of the sidebar. It provides copyable authoring instructions, preserves unfinished drafts and opens tasks in detected coding tools. Start with the [manifest and JS lifecycle guide](docs/EXTENSION-FORMAT.md) and the [Style Lab example](examples/stylelab-script-button/README.md). The format is our own; it does not provide Chrome extension APIs.

Library data lives in `~/Library/Application Support/Extensions Anywhere/library.json`. Imports copy source into that library; editing the original folder does not update the imported copy. Re-import a changed package and remove its superseded record. See [Dock launching](docs/DOCK-LAUNCHING.md) and [recovery](docs/RECOVERY.md) for operational details.

## Build and verify

Development requires Node/npm, Swift 6 and a selected current macOS SDK. The macOS deployment minimum is 14; current live evidence is from Apple silicon on macOS 27. The packaged manager includes its Node runtime.

```sh
npm ci
npm run start:macos
```

This builds and opens `dist/Extensions Anywhere.app`. [Native development details](macos/README.md) explain the SDK checks that preserve the system's native appearance.

```sh
npm run build:fixture  # Build our owned Style Lab fixture while it is stopped
npm test              # Includes an owned-fixture integration run
npm run test:macos    # Native tests; installed-app E2E tests require explicit opt-ins
```

The latest native source checkpoint passed **301 tests, with 5 live opt-ins skipped and zero failures**; the latest Node checkpoint passed **260 tests**. Build 11’s earlier 242-test checkpoint remains tied to its live proofs. The earlier six-test focused authoring rerun is not added to the unique native count. These results are separate from build-bound live app proofs. `npm run verify:fixture-js` exercises the fixed owned package/lifecycle; `npm start` opens the original Electron proof controller, which is separate from the SwiftUI manager.

## Updates and release state

Sparkle's actual **manager 3 → 11 self-update passed**, including public download, signature checks, replacement and self-relaunch without a manual open command. Library bytes, Dock and restart/update choices were preserved; usage history remained with one recorded activation. [Proof and exact limits](docs/release-review/2026-09-13/real-manager-self-update.md). The separate [test prerelease](https://github.com/b-nnett/electron-extensions/releases/tag/updater-e2e-20260913) is outside Latest; release 0.1.14 uses the normal signed production feed. [Update runbook](docs/AUTO-UPDATES.md).

## Historical compatibility research

The September 2026 CLI work recorded **44 accepted CSS round trips out of 49 target apps**, with version, screen and lifecycle qualifications. That dated result is not a claim of 44 current native CSS + JS integrations. 1Password was excluded.

- [Original nine-app results](COMPATIBILITY.md) and [launch instructions](docs/INJECTION-GUIDE.md)
- [Forty-app expansion and evidence](docs/EXPANSION-VERIFICATION.md), [catalog](docs/APP-CATALOG.md) and [saved results](compatibility/results.json)
- [Pipe-based integrations](docs/PIPE-GUIDE.md), [Claude setup](docs/CLAUDE-DEVELOPER-MODE.md) and [failure follow-ups](docs/FAILURE-FOLLOWUP.md)

Target apps are never patched, re-signed, or given changed entitlements/fuses. Our separate manager, launchers and owned test fixture are the bundles we build and sign.
