# Claude Desktop — verified CSS through Developer Mode

Historical CLI evidence from **6 September 2026**. The counts and implementation below describe those trials. For the current native mixed CSS/JS integration and per-launch setup, use [Claude setup](CLAUDE-SETUP.md); its 25-check new-chat lifecycle proof passed on Claude 1.52386.6 with manager build 13.

**Claude Desktop passed three complete CLI CSS trials on Electron 42.10.0:** two in one 1.46388.3 session, followed by one in a fresh normal 1.46388.4 process. The **Use incognito** ghost-icon button on `https://claude.ai/new` changed from its original dark appearance to a green background with a white icon, then restored. All nine control screenshots were reviewed. Computed application/restoration, strict signing and the fingerprints of all 3,283 bundle files matched each trial's own baseline.

| Trial | Programmatic checks | Visual review |
| --- | --- | --- |
| First, 1.46388.3 / PID 80593 | [Report](../output/compatibility/claude/developer-mode/2026-09-06T11-41-33.200Z/report.json) | [Three-image review](../output/compatibility/claude/developer-mode/2026-09-06T11-41-33.200Z/visual-review.json) |
| Second, same 1.46388.3 session | [Report](../output/compatibility/claude/developer-mode/2026-09-06T11-42-15.909Z/report.json) | [Three-image review](../output/compatibility/claude/developer-mode/2026-09-06T11-42-15.909Z/visual-review.json) |
| Third, fresh 1.46388.4 / PID 93518 | [Report](../output/compatibility/claude/developer-mode/2026-09-06T11-51-37.312Z/report.json) | [Three-image review](../output/compatibility/claude/developer-mode/2026-09-06T11-51-37.312Z/visual-review.json) |

Claude is included in the current **44/49 accepted CSS results**, or **35/40 additional apps**. The route uses normal setup in Claude's own UI followed by a separate programmatic verifier. All three CSS application, removal and capture trials used the CLI. No control was clicked and no account action was performed. The latest `npm test` run passed **41 tests**, with no failures; see the [saved log](../output/compatibility/claude/developer-mode-setup/npm-test.log).

## Normal UI setup

1. Start the installed Claude Desktop normally.
2. If Developer Mode is not already enabled, select **Help → Troubleshooting → Enable Developer Mode**. Claude's official [MCP App troubleshooting guide](https://claude.com/docs/connectors/building/mcp-apps/troubleshooting) documents this option and the resulting Developer menu.
3. In the Developer menu, select **Enable Main Process Debugger**, if available, and review the app's prompt. This menu item and its local inspector were observed in the installed app. The linked Claude documentation describes built-in DevTools; the recorded app-menu and runtime evidence establish the external main-process route for these builds.
4. Identify the current Claude main-process PID. The verifier requires that exact process to own an exclusive `127.0.0.1:9229` listener and validates its kernel executable identity and start time.

Developer Mode persisted across the observed restart. The inspector closed with the old process and needed menu activation again in the fresh process. This is not a promise of unattended setup or reconnection across all sessions. The historical PIDs above must not be reused as proof of ownership.

The [setup and cleanup report](../output/compatibility/claude/developer-mode-setup/report.json) records the final state: normal Cmd+Q exited PID 93518 and closed port 9229; kernel checks of 11 main/helper executable paths found no remaining matches or unresolved identities. Final signing and bundle fingerprints matched the latest trial. **Developer Mode remains enabled.** The observed 1.46388.4 Help menu offered no Disable Developer Mode item, so the supported persistent setting was retained without editing private preferences. The original setting was not restored.

## Reproduce the CLI proof

From the repository root, replace the literal `CLAUDE_PID` with the current Claude main-process PID. Run the read-only preview:

```sh
node scripts/verify-claude-developer-mode.mjs CLAUDE_PID --preview
```

Inspect the returned crop and confirm the recognizable **Use incognito** icon button. The verifier is fixed to the exact `https://claude.ai/new` page and unique `button[aria-label="Use incognito"]` selector. Then run:

```sh
node scripts/verify-claude-developer-mode.mjs CLAUDE_PID --verify
```

The [verifier](../scripts/verify-claude-developer-mode.mjs) records a new timestamped folder under `output/compatibility/claude/developer-mode/`. It attaches to the explicitly verified existing app; it does not launch or quit that app and does not change Developer Mode itself. Read-only renderer checks verify the control and its computed appearance. Fixed main-process calls apply and remove the stylesheet, while strict signing and fingerprints are checked before, during and after the trial.

Review `report.json` and all three PNGs. Acceptance requires `css.matchesExpected`, `css.matchesOriginal`, `activeUnchanged`, `unchanged`, `stylesheetRemoved`, `controllerDisconnected` and `cssPass` to be true, with no errors or unresolved trial cleanup. Save a visual review confirming the same recognizable icon before, green and restored. An API acknowledgement alone is insufficient.

Each verification removes its own keyed stylesheet and disconnects its inspector client. A 15-second automatic rollback is also armed during application. A temporary page-debugger connection used for capture is detached afterward; the verifier refuses to replace an already-attached renderer debugger. Closing the inspector and app is a separate normal setup-cleanup step. Retaining the authorized Developer Mode setting is recorded separately from successful stylesheet removal and client disconnection.

## CSS and screenshot implementation

The working adapter uses **author-origin CSS**, the default origin documented by Electron. `webContents.insertCSS()` returns a key, and `removeInsertedCSS()` removes that stylesheet. The original values returned after removal in all three successful trials. [Electron CSS API](https://github.com/electron/electron/blob/main/docs/api/web-contents.md#contentsinsertcsscss-options).

The earlier user-origin attempt changed computed colors but failed removal. That behavior was independently reproduced in an [owned Electron fixture](../output/owned-insert-css/2026-09-06T11-40-09.040Z/report.json), where default author-origin removal worked. This evidence supports the adapter's origin choice; it does not attribute the removal failure to a Claude debugging guard.

Native `webContents.capturePage()` returned stale control imagery in the earlier Claude trial. The working verifier uses a temporary `webContents.debugger` connection to request a cropped `Page.captureScreenshot`. The nine reviewed PNGs establish the actual visual change and restoration for the successful method. [Electron debugger API](https://www.electronjs.org/docs/latest/api/debugger), [CDP page capture](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot).

## Main-process trust boundary

This route executes **fixed JavaScript in Claude's main process**, plus fixed read-only JavaScript in the selected renderer. It is a CSS customization proof; arbitrary production-extension JavaScript and isolation of untrusted extensions remain unverified. The fixture remains the only demonstration of a newly injected button with a JavaScript handler, console events and reload behavior.

Electron's main-process debugger exposes the V8 inspector to an external debugger; it is a different execution context from window DevTools. Node can activate the inspector after normal startup, so a vendor can expose it through a menu. [Electron main-process debugging](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process), [Node inspector API](https://nodejs.org/api/inspector.html#inspectoropenport-host-wait).

The Node inspector grants access to the full process execution environment, including to local clients when bound to loopback. Our fixed operation list restricts our own verifier; it does not make the inspector a CSS-only permission boundary or isolate arbitrary extensions. Limit the active inspector to supervised use and verify that normal app shutdown closes its listener. Developer Mode remaining enabled does not mean the inspector remains open after the app exits. [Node inspector trust model](https://nodejs.org/learn/getting-started/debugging#security-implications).

## Earlier methods and version boundary

The earlier build **1.9659.2 / Electron 41.6.1** refused the tested remote-debugging startup flags, but later exposed its normal Developer menu and main inspector for read-only metadata. During setup, the installed bundle and app process changed to **1.46388.3 / Electron 42.10.0** before any CSS trial. After its two passes, a fresh normal **1.46388.4 / Electron 42.10.0** process passed the third trial. The causes of these bundle changes have not been independently established. Do not attribute them to an updater or combine integrity baselines across builds.

The earlier failures remain valid for their recorded methods. The successful main-inspector route changes no guard, hidden preference, authorization material, entitlement or vendor bundle. One fresh-process confirmation is established; automatic reconnection, persistence across navigation or restarts, arbitrary Chrome-extension support and a supported route for Evernote remain unproven. See [live results](../compatibility/results.json) for current coverage.
