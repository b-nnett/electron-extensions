# Production app compatibility — 6 September 2026

**Current sweep: 44 of 49 apps have verified CSS application and restoration**, including all original nine and **35 of 40 additional apps**. A verified CSS result requires the visible before/green/restored control, matching computed application/restoration, and unchanged signing and bundle fingerprints. **AFFiNE is included with a shutdown reliability caveat:** its successful CSS trial ended with `SIGSEGV`; the cause is undetermined. See its [report](output/compatibility/affine/pipe/2026-09-05T20-13-43.969Z/report.json) and [visual review](output/compatibility/affine/pipe/2026-09-05T20-13-43.969Z/visual-review.json).

Among the additional 40, **37 were newly installed and two were already present**, so 39 have permanent installations. Rancher Desktop was the 40th candidate and was tested from a read-only vendor image after the normal installation was blocked by capacity. It was **not permanently installed**. All 40 now have shipped Electron-framework evidence; architecture evidence alone does not establish runtime compatibility.

The complete per-app matrix, selectors and evidence are in [Expansion verification](docs/EXPANSION-VERIFICATION.md) and [the live results JSON](compatibility/results.json). [The app catalog](docs/APP-CATALOG.md) retains source and popularity caveats. These are observations of the tested versions and screens, not a popularity ranking or a universal compatibility guarantee. 1Password remains excluded and is outside the 49-app denominator.

| Additional app outside the verified CSS count | Observed limit | Evidence |
| --- | --- | --- |
| Evernote | Normal startup succeeded. The production executable explicitly refused remote debugging and exited with code 0. No supported external route was found. | [Diagnosis](output/compatibility/evernote/diagnostics/2026-09-05T23-07-29.784Z/diagnosis.json) |
| Joplin | Pipe target discovery stalled; an ordinary LaunchServices launch exposed an owned TCP listener, but its target list timed out. | [Follow-up](output/compatibility/joplin/launchservices-followup.json) |
| Mattermost | TCP computed CSS application/restoration passed, but all three crops lacked a recognizable visible control. | [Visual review](output/compatibility/mattermost/visual-review.json) |
| Wave Terminal | Computed CSS passed, but the three crops were blank/dark and did not verify a visible control or green change. | [Visual review](output/compatibility/wave/pipe/2026-09-05T19-49-09.220Z/visual-review.json) |
| Rancher Desktop | CSS application/restoration, unchanged integrity and all three visuals were observed from the read-only image, but the lifecycle remained incomplete. It is not counted as verified or permanently installed. | [Preparation](output/compatibility/rancher/image-test-preparation.json), [visual review](output/compatibility/rancher/pipe/2026-09-05T20-15-58.751Z/visual-review.json) |

There are now two startup/target-discovery cases, two visual-verification cases and Rancher's lifecycle-incomplete case outside the accepted count. Including Rancher, **45 visible CSS round trips were observed**. The prioritized Compass/Claude/Evernote follow-up now has two working CSS routes; Evernote retains its explicit production-debugging restriction. This sweep uses fixed cosmetic CSS. Claude's adapter executes fixed main-process JavaScript plus read-only renderer checks; **arbitrary production-extension JavaScript remains unverified**. The verifiers are CLIs, while the controller GUI and injected JavaScript-button demonstration still target the owned fixture. Follow [the pipe guide](docs/PIPE-GUIDE.md), [Claude's separate guide](docs/CLAUDE-DEVELOPER-MODE.md), and [the original nine-app guide](docs/INJECTION-GUIDE.md).

Claude passed **three complete CLI trials on Electron 42.10.0**: two in the same 1.46388.3 session, then one in a fresh normal 1.46388.4 process. Its **Use incognito** ghost-icon button on `https://claude.ai/new`, selected by `button[aria-label="Use incognito"]`, changed to green/white and restored. Nine PNGs were reviewed; computed checks and all 3,283 bundle files plus signing matched each trial's own before, active and after baselines. Keyed CSS removal and controller disconnection succeeded. This uses the app's normal Developer Mode and Enable Main Process Debugger setup, author-origin CSS and a temporary page-debugger capture bridge. Developer Mode persisted across restart, while the inspector required menu activation again. After the final trial, normal quit closed the app and port 9229; kernel checks found no remaining main/helper processes, and final integrity matched the latest trial. Developer Mode remains enabled: the observed 1.46388.4 menu had no Disable Developer Mode item, and the original setting was not restored. See the [latest report](output/compatibility/claude/developer-mode/2026-09-06T11-51-37.312Z/report.json), [visual review](output/compatibility/claude/developer-mode/2026-09-06T11-51-37.312Z/visual-review.json), [setup and cleanup](output/compatibility/claude/developer-mode-setup/report.json) and [reproduction and trust boundary](docs/CLAUDE-DEVELOPER-MODE.md).

MongoDB Compass 1.50.0 remains an accepted pass. Two fresh pipe trials turned its welcome modal's **Start** button green and restored it using `button.leafygreen-ui-da5f2u`; six screenshots were reviewed, signing and fingerprints matched, and both runs cleaned up without forced termination. Its command-line parser required the vendor-documented `--ignoreAdditionalCommandLineFlags` option, now added automatically by the fixed Compass adapter in both pipe and TCP harnesses. The successful CSS evidence is pipe-only. See the [two-run confirmation](output/compatibility/compass/diagnostics/2026-09-05T22-59-41.159Z/adapter-confirmation.json), [latest report](output/compatibility/compass/pipe/2026-09-05T23-14-58.633Z/report.json), and [MongoDB's option documentation](https://www.mongodb.com/docs/compass/settings/command-line-options/).

The previous sweep audit incorrectly claimed no additional-app main process remained: Compass changed its displayed process name, so the full-path `ps` check missed a live process. The [diagnosis](output/compatibility/compass/diagnostics/2026-09-05T22-59-41.159Z/diagnosis.json) records the correction. Shared ownership checks now use kernel executable identity and start time through read-only `libproc` calls via Python 3. Six before/active/after kernel audits are referenced in the two-run confirmation. Earlier failed attempts remain preserved; their old cleanup claim should not override this correction.

## Original nine-app results and historical evidence

The original ten shortlisted apps were installed in `/Applications`. **Programmatic CSS application and restoration passed in all nine active apps: eight through CDP over a loopback TCP connection and Figma through CDP over a debugging pipe.** No Computer Use was required by the Figma proof. Signal used its help link; the other eight passes used buttons. The user excluded 1Password from further work.

The earlier nine-of-nine claim based on a Figma DevTools edit through Computer Use was incorrect. That remains diagnostic evidence only. The new pipe-based proof independently meets the requirement for a separate process to apply and remove CSS programmatically without UI driving.

**All ten original candidates retained valid vendor signatures and identical bundle fingerprints throughout those compatibility trials.** No production app was patched or re-signed.

Host: macOS 27.0 (26A5421a), Apple Silicon (`arm64`). These are observations of the installed versions and screens below, not guarantees for other releases or configurations.

## Original results matrix

| App | Version | CSS result | Control / observed limitation | Evidence |
| --- | --- | --- | --- | --- |
| Slack | 4.52.155 | Pass | Sign in to Slack button | [Report](output/compatibility/slack/report.json) |
| Visual Studio Code | 1.135.0 | Pass | Continue with GitHub button in onboarding | [Report](output/compatibility/vscode/report.json) |
| Notion | 7.32.0 | Pass | Continue in Browser button | [Report](output/compatibility/notion/report.json) |
| Signal | 8.26.0 | Pass | Need help? link; same CSS mechanism as the button tests | [Report](output/compatibility/signal/report.json) |
| Postman | 12.26.5 | Pass | Create Free Account button | [Report](output/compatibility/postman/report.json) |
| Obsidian | 1.13.7 | Pass | Quick start button | [Report](output/compatibility/obsidian/report.json) |
| GitHub Desktop | 3.6.3 | Pass | Sign in to GitHub.com button | [Report](output/compatibility/github/report.json) |
| Discord | 0.0.410 | Pass | Find or start a conversation button; LaunchServices with existing profile | [Latest report](output/compatibility/discord/report.json), [working launch](output/compatibility/discord/launchservices-followup.json) |
| Figma | 126.8.18 | Pass — external CDP pipe | Log in with browser button; two fresh launches passed automated CSS application, restoration, and integrity checks | [Latest report](output/compatibility/figma/pipe/2026-09-05T16-02-59.975Z/report.json), [first run](output/compatibility/figma/pipe/2026-09-05T16-00-54.661Z/report.json) |
| 1Password | 8.12.34 | Excluded | Removed from active scope by user after the initial unavailable-endpoint result | [Historical report](output/compatibility/1password/report.json) |

An unavailable endpoint means that launch method did not complete the CDP test. Its cause has not been established; it does not establish universal incompatibility or an intentional debugging restriction.

## Visual evidence

All nine programmatic trials saved before, green, and restored control screenshots below; all were visually checked. Both fresh Figma pipe runs also had their three screenshots inspected.

| App | Before | Green | Restored |
| --- | --- | --- | --- |
| Slack | [PNG](output/compatibility/slack/before.png) | [PNG](output/compatibility/slack/green.png) | [PNG](output/compatibility/slack/restored.png) |
| VS Code | [PNG](output/compatibility/vscode/before.png) | [PNG](output/compatibility/vscode/green.png) | [PNG](output/compatibility/vscode/restored.png) |
| Notion | [PNG](output/compatibility/notion/before.png) | [PNG](output/compatibility/notion/green.png) | [PNG](output/compatibility/notion/restored.png) |
| Signal | [PNG](output/compatibility/signal/before.png) | [PNG](output/compatibility/signal/green.png) | [PNG](output/compatibility/signal/restored.png) |
| Postman | [PNG](output/compatibility/postman/before.png) | [PNG](output/compatibility/postman/green.png) | [PNG](output/compatibility/postman/restored.png) |
| Obsidian | [PNG](output/compatibility/obsidian/before.png) | [PNG](output/compatibility/obsidian/green.png) | [PNG](output/compatibility/obsidian/restored.png) |
| GitHub Desktop | [PNG](output/compatibility/github/before.png) | [PNG](output/compatibility/github/green.png) | [PNG](output/compatibility/github/restored.png) |
| Discord | [PNG](output/compatibility/discord/before.png) | [PNG](output/compatibility/discord/green.png) | [PNG](output/compatibility/discord/restored.png) |
| Figma | [PNG](output/compatibility/figma/pipe/2026-09-05T16-02-59.975Z/before.png) | [PNG](output/compatibility/figma/pipe/2026-09-05T16-02-59.975Z/green.png) | [PNG](output/compatibility/figma/pipe/2026-09-05T16-02-59.975Z/restored.png) |

## Discord and Figma follow-up

Discord's direct executable launch exited after about 2.3 seconds both with and without debugging enabled. It logged a secondary-instance quit marker and `EPERM` errors referencing its default Application Support directory, despite a requested temporary user-data directory. No other Discord process was present. This is evidence of a startup/environment/profile problem, not proof that Discord disables remote debugging. See [startup diagnostics](output/compatibility/discord/startup-diagnostic.json).

The successful combination was a normal macOS LaunchServices launch with the existing profile and the ordinary loopback debugging options. After five seconds, the sole Discord main process owned the expected loopback listener and returned its page target. The supervised session then turned **Find or start a conversation** green, restored its original appearance, and verified unchanged bundle contents and signing. This tested the signed-in home screen, not the Log In button. The diagnostic launch was stopped afterward. Because both the launch path and profile option differed from the failed trials, this does not isolate which difference resolved startup.

Figma's working transport is the standard `--remote-debugging-pipe` launch option. [scripts/verify-figma-pipe.mjs](scripts/verify-figma-pipe.mjs) launches the fixed `/Applications/Figma.app` executable with owned pipe descriptors and a requested temporary user-data directory. [lib/pipe-cdp.mjs](lib/pipe-cdp.mjs) carries CDP over child stdio 3/4 and a flattened page session. The proof selects the unique Figma login page and `button[type="submit"]`, revalidates the login route, and uses `Page`, `DOM`, and `CSS` commands to apply, inspect, screenshot, and remove the fixed cosmetic stylesheet. No DevTools UI or Computer Use is involved.

Two fresh launches passed. The button changed from black `rgb(0, 0, 0)` with text `rgba(255, 255, 255, 0.898)` to green `rgb(22, 163, 74)` with white text, then restored its original values. Its background image remained `none` and dimensions remained `233 × 48`. All 295 physical bundle files and the vendor signature matched before, while green, and after cleanup. Each owned process exited with code 0 and its temporary profile directory was removed; no Figma process remained after the second run. At that stage, the pipe library's nine unit checks also passed.

Earlier TCP launches produced no usable endpoint; those [LaunchServices](output/compatibility/figma/launchservices-followup.json) and [explicit-port](output/compatibility/figma/endpoint-fixed-port.json) observations remain valid for the methods tested. A separate [built-in DevTools UI diagnostic](output/compatibility/figma/devtools-ui-retry/report.json) applied and restored CSS with signing unchanged, but did not qualify as a project pass. The current result rests on the automated pipe proof. No hidden debugging unlocks or protection changes were attempted.

## What was verified

The eight TCP passes used Electron's ordinary remote-debugging launch options. Before connecting, the harness checked that the selected app process owned an exclusively `127.0.0.1` listener. Figma instead used pipe descriptors created for the process launched by the proof. Both transports use the CDP `Page`, `DOM`, and `CSS` domains with an explicitly selected page and unique element selector.

Each of the nine passing CDP trials applied a dedicated runtime stylesheet with a green background (`rgb(22, 163, 74)`), white text, and no background image. The harnesses checked computed values programmatically, and screenshots confirmed the visible changes. Clearing the stylesheet restored the observed pre-trial appearance, including background images such as Notion's original gradient. Slack's pre-trial button was blue from the existing session; restoration is to that observed state, not a claim about Slack's factory theme.

Strict deep signature verification, CDHash, and a recursive SHA-256 bundle fingerprint were checked before, during, and after successful CSS trials. Failed attachment trials were checked before and after. All matched their trial baselines. The fingerprint covers physical file contents, paths, modes, and symlink destinations.

Fresh temporary user-data directories were requested for the initial launched trials. Apps may interpret that option differently; profile isolation is not a general guarantee. Slack reused an already-running, verified local debugging session on its sign-in screen. VS Code used a separate temporary profile with extensions disabled. Discord's successful follow-up used its existing signed-in profile. The remaining successful trials used initial login or setup screens. No account was created and no service button was clicked.

Figma's small vendor installer initially produced an installation that failed signature verification. Before compatibility testing, the official full Apple Silicon app archive was installed through Finder, and strict verification passed. The CSS trial baseline is that valid full installation. The change from the earlier installation observation is not a runtime bundle modification. Installation evidence: [current inventory](output/compatibility/current-installed.json), [earlier observation](output/compatibility/installation-baselines.json).

## Scope of the conclusion

The current evidence supports programmatic CSS customization on the recorded screens in 44 of 49 apps, with AFFiNE's shutdown caveat retained. The original nine are included in that total. Figma's pipe connection requires launching the app with descriptors owned by the controller process; it does not attach to an arbitrary already-running Figma process. Its proof is restricted to the observed login page, and reload persistence is untested. These observations do not yet support the promise “any Electron app.”

These production trials prove temporary CSS changes on the observed screens. They do not prove arbitrary Chrome extensions, production-app JavaScript handlers, click behavior after styling, reconnecting across restarts, updates, background windows, or persistence across navigation. The separate owned fixture covers the existing JavaScript-button and reload demonstrations; its earlier fourteen-check integration proof recorded a pass. Use `npm test` for a fresh repository check.

The production TCP harness, Figma proof, catalog pipe harness and Claude main-inspector verifier are CLIs, outside the controller UI. Claude requires a normal UI setup opt-in, but its styling is programmatic. No ASAR edits, fuse changes, entitlement changes, undocumented debugging unlocks or protection bypasses were used.

## Handoff and reproduction

The [original per-app CSS guide](docs/INJECTION-GUIDE.md) collects the nine observed selectors and launch recipes. The [pipe guide](docs/PIPE-GUIDE.md) documents catalog installation and the explicit control workflow. [Claude's guide](docs/CLAUDE-DEVELOPER-MODE.md) documents its separate existing-process CLI and Developer Mode setup. Use [live results](compatibility/results.json) and [the full sweep](docs/EXPANSION-VERIFICATION.md) for current evidence. Arbitrary production-extension JavaScript remains unverified; the injected JavaScript-button guide applies only to the owned fixture.

`scripts/compatibility-session.mjs` accepts its fixed app map, including the original nine and selected follow-up apps, and emits newline JSON. For example, `node scripts/compatibility-session.mjs notion` starts a supervised TCP session. Inspect its returned targets, then send `buttons` with an explicit `targetId`; send `apply` with that target and a unique selector; finally send `remove` and `stop`. Selectors and exact computed results from this run are in the reports. For Discord, the direct-launch default still has the observed limitation: use a supervised LaunchServices launch and then existing-process mode with its freshly verified PID/port, as recorded in the working launch report. No automatic fallback was added.

`lib/cosmetic-trial.mjs` implements the bounded stylesheet operation. The session verifies ownership and integrity, records control screenshots, clears its stylesheet, and stops only its own launched process. Existing-process mode verifies the supplied PID and port and leaves that process running. Do not assume a previously recorded PID or port still belongs to the same app.

Run the Figma proof with:

```sh
npm run verify:figma
```

[scripts/verify-figma-pipe.mjs](scripts/verify-figma-pipe.mjs) performs the launch, target validation, CSS application and restoration, screenshots, integrity checks, and cleanup. It writes a new timestamped directory under `output/compatibility/figma/pipe/`. The proof is restricted to `/Applications/Figma.app` and its login button; the fixed rule is also preserved in [styles/figma-green.css](styles/figma-green.css). The generic TCP session script does not implement this pipe launch.

Reports and saved screenshots live under `output/`, which is gitignored. Preserve that directory when transferring this local handoff. `status: complete` in older session reports describes session completion. A project compatibility pass requires external programmatic CSS application, restoration, and unchanged integrity; a successful UI edit does not qualify. New CDP sessions also write an explicit `verdict`.
