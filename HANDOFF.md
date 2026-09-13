# Extensions Anywhere MVP handoff

## Current state

**44 of 49 production apps have verified temporary CSS application and restoration: all original nine plus 35 of 40 additional apps.** Verification includes the visible before/green/restored control, computed styles, vendor signing and bundle fingerprints. AFFiNE counts as a CSS pass, with an unresolved shutdown reliability caveat: its owned process exited with `SIGSEGV`. Its [final CSS report](output/compatibility/affine/pipe/2026-09-05T20-13-43.969Z/report.json) and [visual review](output/compatibility/affine/pipe/2026-09-05T20-13-43.969Z/visual-review.json) preserve both observations.

Four apps remain CSS-unverified: **Evernote and Joplin** did not reach CSS, while **Mattermost and Wave Terminal** lack visual verification after computed CSS round trips. Rancher Desktop is separately lifecycle-incomplete: CSS application/restoration, unchanged integrity and three visual captures were observed, but it is excluded from the accepted count. Its bounded trial used a read-only vendor image after installation was blocked by capacity; it was **not permanently installed**. Consult its [source preparation](output/compatibility/rancher/image-test-preparation.json) and [trial report](output/compatibility/rancher/pipe/2026-09-05T20-15-58.751Z/report.json) for lifecycle evidence.

The additional sweep installed 37 apps and included two already present, giving **39 permanent installations plus Rancher's image trial**. All 40 have shipped Electron-framework evidence. 1Password remains excluded and is outside the 49-app denominator. These are version- and screen-specific observations, not a claim of universal Electron support.

The prioritized follow-up now has **Compass and Claude CSS-working; Evernote remains blocked**. Compass 1.50.0 passed two fresh pipe trials using its documented `--ignoreAdditionalCommandLineFlags` parser option, automatically added by both harnesses. Only its pipe route has successful CSS evidence. See the [Compass confirmation](output/compatibility/compass/diagnostics/2026-09-05T22-59-41.159Z/adapter-confirmation.json). Claude passed three CLI trials on Electron 42.10.0 after normal Developer Mode and main-debugger setup: two in one 1.46388.3 session and one in a fresh normal 1.46388.4 process. The **Use incognito** icon changed to green/white and restored; nine images, computed checks and all 3,283 bundle files/signing matched each trial's own baseline. Keyed stylesheet removal and controller disconnection succeeded. See [Claude's latest report](output/compatibility/claude/developer-mode/2026-09-06T11-51-37.312Z/report.json) and [setup/reproduction guide](docs/CLAUDE-DEVELOPER-MODE.md). Developer Mode persisted across restart, but the main inspector needed menu activation again. Final normal quit closed the app and inspector; kernel checks found no remaining main/helper processes, and final signing/fingerprints matched the latest trial. Developer Mode remains enabled because the observed current menu had no Disable Developer Mode item; the original setting was not restored. The [setup report](output/compatibility/claude/developer-mode-setup/report.json) records that distinction.

The [failure analysis and next checks](docs/FAILURE-FOLLOWUP.md) separates the remaining five results into two startup/target-discovery cases, two visual-verification cases and Rancher's lifecycle case. Live coverage records **45 visible round trips including Rancher**, with **44 accepted CSS verdicts**. Earlier 42/49 and 43/49 counts remain historical snapshots before the new Compass and Claude passes. Claude's previous startup-flag refusals remain method-specific evidence; its working route uses the normal app menu, not a guard change. Evernote's current documentation yielded no supported external styling route.

The vendor-app installer and CSS verifiers are **CLIs**. The controller GUI and injected JavaScript-button demonstration still target only the owned fixture. Claude's adapter uses fixed main-process JavaScript and read-only renderer checks; arbitrary production-extension JavaScript, event handlers and Chrome-extension compatibility remain unverified. Use [live results](compatibility/results.json), [full sweep and evidence](docs/EXPANSION-VERIFICATION.md), [research catalog](docs/APP-CATALOG.md), [installer and pipe guide](docs/PIPE-GUIDE.md), [Claude Developer Mode guide](docs/CLAUDE-DEVELOPER-MODE.md), and [original nine-app guide](docs/INJECTION-GUIDE.md). Preserve `output/` with this handoff because reports and screenshots are gitignored.

The latest `npm test` run passed **41 tests**, with no failures; see the [saved log](output/compatibility/claude/developer-mode-setup/npm-test.log). Claude's three complete CLI CSS trials, including one fresh-process confirmation, are separate production verification. The earlier [sweep evidence audit](output/final-audit/report.json) checked 126 CSS screenshots, installation-copy integrity records and local documentation links, but its claim that no additional-app main process remained was incorrect. Compass renamed its displayed process, so the old full-path `ps` inventory missed it. The [diagnosis](output/compatibility/compass/diagnostics/2026-09-05T22-59-41.159Z/diagnosis.json) records the correction and cleanup. Ownership now uses kernel executable identity and start time through read-only macOS `libproc` calls via `/usr/bin/python3`. Six before/active/after kernel audits around the two new Compass trials confirmed ownership and cleanup without forced termination. The harness also preserves its pipe for stylesheet cleanup after interruption and records lifecycle timing. Rancher's preparation report separately records its guarded image and runtime-data cleanup; installed application bundles were retained.

## Goal

Prove that a separate macOS controller can apply and remove CSS and add a new button with a JavaScript handler inside an ordinary Electron app at runtime, without modifying the target app bundle or its code signature.

## Original nine-app proof and historical detail

All ten original shortlisted apps were installed with valid vendor signatures. Programmatic CSS application and restoration passed in all nine active apps: Slack, VS Code, Notion, Signal, Postman, Obsidian, GitHub Desktop, and Discord through CDP over loopback TCP, and Figma through CDP over a debugging pipe. These nine remain included in the current 44 verified results. Signal used a help link; the other passes used buttons. Discord passed after a LaunchServices launch with its existing profile. The user excluded 1Password from further work. Every original trial preserved the bundle fingerprint and signature. See [COMPATIBILITY.md](COMPATIBILITY.md) for the matrix and evidence.

The earlier nine-of-nine claim based on Computer Use was incorrect. Figma's DevTools UI observation remains diagnostic evidence only. The new automated pipe proof independently meets the requirement to apply and remove CSS from a separate process without UI driving.

The eight original TCP passes use `scripts/compatibility-session.mjs` and `lib/cosmetic-trial.mjs`. Figma uses [scripts/verify-figma-pipe.mjs](scripts/verify-figma-pipe.mjs) and [lib/pipe-cdp.mjs](lib/pipe-cdp.mjs), run with `npm run verify:figma`. These are programmatic CLI proofs with explicitly selected targets and fixed cosmetic CSS. The controller UI still targets the owned fixture. Arbitrary production JavaScript/Chrome extension compatibility has not been established. At that stage, the fourteen-check fixture integration proof and nine pipe-library unit checks had passed; those are historical results, not a current suite-total claim.

Figma's pipe proof passed on two fresh launches; the [latest report](output/compatibility/figma/pipe/2026-09-05T16-02-59.975Z/report.json) and [first run](output/compatibility/figma/pipe/2026-09-05T16-00-54.661Z/report.json) contain computed application/restoration results, with before/green/restored PNGs alongside each report. The script launches only `/Applications/Figma.app` with `--remote-debugging-pipe` and a requested temporary profile, communicates over owned stdio 3/4, and uses a flattened CDP page session. It requires the unique Figma login page and `button[type="submit"]`, then applies, verifies, and clears the fixed CSS. The black button turned green and restored its original colors, background image, and `233 × 48` dimensions. All 295 bundle files and the vendor signature matched before, during, and after. Both owned processes exited with code 0 and their temporary profile directories were removed. All six screenshots were visually checked, and no Figma process remained after cleanup.

The Figma pipe transport requires descriptors established when our process launches the app. Attachment to an arbitrary already-running Figma process, persistence across reloads, and integration into the controller GUI are untested. The earlier [DevTools UI diagnostic](output/compatibility/figma/devtools-ui-retry/report.json) and [fixture pipe metadata check](output/pipe-fixture/report-2026-09-05T14-56-28.434Z.json) remain historical observations; neither is the basis for Figma's compatibility pass.

The repository contains a deliberately ordinary Electron fixture called **Style Lab**. It has no preload bridge, extension loader, IPC customization API, or CSS injection code. It is packaged with Electron 44.2.0 for macOS arm64 and ad-hoc signed with Hardened Runtime.

The fixture was built successfully at:

`dist/Style Lab-darwin-arm64/Style Lab.app`

The runtime controller pieces are implemented in:

- `lib/cdp.mjs` — minimal Chrome DevTools Protocol WebSocket client and stylesheet controller.
- `lib/fixture-session.mjs` — launches the signed fixture with an externally supplied remote debugging port, finds its page target, connects to CDP, and checks lifecycle/integrity.
- `lib/integrity.mjs` — runs `codesign --verify --deep --strict` and computes a recursive bundle fingerprint.
- `controller/` — separate Electron editor UI with a narrow preload API, serialized actions, and session cleanup.
- `styles/neon.css` and `styles/lilac.css` — example external stylesheets targeting `#signal-button`.
- `extensions/button-demo.js` and `.css` — the externally injected **Log a message** button and its styling. These are outside the signed fixture.
- `lib/button-demo.mjs` — fixed demo installation/removal in a named renderer world, reload handling, and filtered `Runtime.consoleAPICalled` events for the controller's console feed.

The CDP controller uses `Page`, `DOM`, and `CSS` domains. It creates a runtime stylesheet with `CSS.createStyleSheet`, writes it with `CSS.setStyleSheetText`, inspects the resulting computed button styles, reapplies after top-level navigation, and can remove the stylesheet.

## Verification completed after resuming

The earlier fixture end-to-end proof passed all fourteen checks via `npm test` (also available as `npm run verify`). It checks CSS changes/restoration, the original button, injection of a new button, real console events from its JavaScript click handler, repeated installation without duplicate buttons/listeners, reload of both demos together, independent removal, and bundle integrity during and after use. Evidence is in `output/verification/report.json` plus seven screenshots. Console click counts in that automated proof were `[1, 2, 1]`, with the last event coming after reload. Use a fresh `npm test` result for the current repository suite.

The verified bundle contains 265 regular files. Its before/after CDHash and recursive bundle SHA-256 both match. See the report for exact hashes; a new build can change them.

The initial ad-hoc build passed static signature verification but failed to launch because its executable and libraries had no matching Team ID. The build now includes `disable-library-validation` alongside `allow-jit` from the outset. Hardened Runtime remains enabled. This is an explicit limitation of the test baseline: it does not prove compatibility with Developer ID signed production apps enforcing library validation. No entitlements or signatures are changed at runtime.

## Controller complete and manually verified

`npm start` opens the controller. The native UI was exercised end to end:

1. Launch the signed fixture.
2. Apply neon CSS and click the live fixture button successfully.
3. Reload and confirm the style is reapplied.
4. Remove and confirm the original computed appearance returns.
5. Quit the controller and confirm its fixture process exits.
6. Relaunch, apply lilac CSS, and verify all 265 physical files and the signature are unchanged.

`FixtureSession.reload()` resolves with the button snapshot after page load and stylesheet reapplication. Styles persist while the controller is connected; they are not saved across app restarts.

One bug caught by the UI verification was Electron's virtual handling of `app.asar`: ordinary Electron `fs` enumerates archive contents as if they were separate files. `lib/integrity.mjs` now uses `original-fs` under Electron, hashing the actual archive bytes. The Node proof and Electron UI now agree on 265 physical files. The nine-check proof was rerun successfully after this fix.

At the end of the earlier UI trial, the controller and fixture were left running with the user's red stylesheet restored and the injected button active. Clicking **Log a message** ran `console.log('[Extensions Anywhere] Button clicked', clicks)` inside the fixture, with real log events visible in the controller. The native UI click and log feed were verified. That is historical state; check current processes before rebuilding or resuming.

The JS feature reuses the exact signed fixture from the CSS proof: no fixture source edits, rebuild, entitlement changes, or signing operations were needed. Both controllers request a dedicated inspector stylesheet with `force: true`; otherwise Chromium reuses one stylesheet and the demo styles overwrite each other after reload. The named JS world shares the DOM and is not a complete untrusted-extension security boundary. The controller exposes fixed add/remove actions, not a general arbitrary-script editor.

## Discord trial

**Superseded by a successful follow-up:** `output/compatibility/discord/report.json` now records the Find or start a conversation button turning green and restoring correctly, with the signature and all 284 bundle files unchanged. `launchservices-followup.json` records the working launch; `startup-diagnostic.json` compares failed direct launches with and without debugging. Both failed direct modes exited in roughly 2.3 seconds with default-profile permission errors and a secondary-instance marker. The successful combination used macOS LaunchServices and the existing profile. The root cause has not been isolated between those differences. This tested a signed-in screen and did not sign the user out to obtain a Log In button.

The following paragraph preserves the original failed trials:

The requested green Log In button trial on `/Applications/Discord.app` version 0.0.410 stopped before stylesheet application. Two clean direct launches using the documented debugging port/address options announced localhost endpoints, then exited with code 0 before attachment. A third LaunchServices launch with a fresh temporary profile produced no reachable endpoint or additional running main process. Normal launch succeeded and restored the signed-in default profile; the View menu had no DevTools item. The empty temporary test profile was removed. The latest compatibility sweep again stopped before attachment: a target-list request failed after the endpoint announcement. Do not assume an earlier app session is still running.

During those original failed trials, no CSS, bundle edits, re-signing, or protection changes were applied. Final integrity verification matched all 284 physical files and the valid Developer ID signature with Hardened Runtime: bundle SHA-256 `81688da1bdbc2d27e61d854b654038034a237bf671513afa495d9ee3bad8ff65`, CDHash `21fb7d572ecf33061c90f898dccdf97faa13e5d9`. Evidence is in `output/discord/report.json`. The cause was undetermined: those methods did not expose a usable debug attachment for this build, which was not a universal Discord incompatibility finding.

## Suggested verification commands

For catalog installation and supervised vendor-app CSS sessions, follow [PIPE-GUIDE.md](docs/PIPE-GUIDE.md). It documents one app per invocation, explicit target/control selection, read-only previews, fixed CSS, restoration, visual review and integrity/cleanup evidence. Use the current result row for the tested selector, then revalidate it before application. Rancher's fixed image option additionally requires separately reviewed source preparation; it is not a permanent-install recipe.

For the owned fixture:

```sh
npm ci
npm run build:fixture
npm test
npm start
```

For the installed Figma login-screen proof:

```sh
npm run verify:figma
```

For a second independent check:

```sh
codesign --verify --deep --strict 'dist/Style Lab-darwin-arm64/Style Lab.app'
codesign -dv --verbose=2 'dist/Style Lab-darwin-arm64/Style Lab.app' 2>&1
```

## Design constraints

- Never patch production `/Applications/*.app` bundles for this MVP. Installing or replacing an app with its official vendor distribution is setup, and must precede its runtime integrity baseline.
- Never re-sign a production app. The only signing step is the fixture build, performed by `scripts/build-fixture.mjs`.
- The target fixture is launched with `--remote-debugging-port=0` and an isolated temporary user-data directory.
- The controller must validate that the CDP endpoint is `127.0.0.1` and that the target page belongs to the launched fixture.
- Keep extension code local and bounded; do not execute arbitrary network-fetched code.

## What this MVP proves

The completed fixture proof shows that external runtime CSS and JavaScript can change the live UI, add a functioning new button, be reapplied after reload, and be removed while the signed bundle's file contents and code signature remain unchanged.

The expanded production sweep records verified programmatic temporary CSS customization in 44 of 49 apps, including the original nine, with unchanged vendor signatures and bundle fingerprints. AFFiNE's shutdown signal remains a reliability caveat, and Rancher's observed CSS round trip remains excluded because its lifecycle was incomplete. These trials do not prove that every app exposes debugging during an ordinary launch without extra options, production JavaScript extensions, multiple windows/frames, a general extension API, extension permissions, or reconnecting across app restarts. ChatGPT was not tested in this sweep. Evidence under `output/` is gitignored and should be retained with this handoff.
