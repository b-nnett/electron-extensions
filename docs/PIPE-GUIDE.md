# Catalog installation and pipe CSS verification

The catalog installer and vendor-app pipe verifier are **CLI tools**. The fixture controller GUI does not yet provide this catalog workflow. This procedure tests a temporary color change on one explicitly selected control; it does not establish Chrome-extension compatibility or JavaScript support in production apps.

Use [the live results](../compatibility/results.json) and [Expansion verification](EXPANSION-VERIFICATION.md) for current app versions, observed controls, limitations and evidence links. The JSON rows include each saved selector; revalidate it against the current page before use. A saved success applies to that tested version, surface and launch mode. A TCP result does not establish pipe support.

The current sweep has **44 accepted CSS results out of 49**, including **35 of 40 additional apps**. Including Rancher's lifecycle-incomplete image trial, 45 visible round trips were observed. Compass uses the fixed pipe adapter below. Claude has a separate verified route through its normal Developer Mode and main-process inspector; follow [Claude's guide](CLAUDE-DEVELOPER-MODE.md), not the generic pipe command. Evernote remains blocked, Joplin stops during target discovery, and Wave/Mattermost lack visual proof. See [the failure follow-up](FAILURE-FOLLOWUP.md).

Run the following from the repository root on the Apple Silicon Mac, with Node.js, npm and `/usr/bin/python3` available. The production harness uses Python 3 for read-only macOS `libproc` identity checks. Install repository dependencies if needed:

```sh
npm ci
```

Choose one slug from [the fixed app catalog](../compatibility/apps.json). For example, install Bruno with:

```sh
node scripts/install-catalog-app.mjs bruno
```

The installer handles one catalogued DMG or ZIP, requires arm64 support and an embedded Electron framework, verifies the source signature, and compares the copied app's signature and bundle fingerprint with the source. It preserves at least 8 GiB of planned free space, refuses to replace an existing app, and records its result under `output/installations/<slug>/`. Review `status`, `errors`, `source.metadata`, `installed`, `unchanged` and staging cleanup. `already-installed` means the copy was skipped; that invocation does not verify the existing bundle. The pipe session performs its own baseline inspection.

The downloaded SHA-256 is always recorded. `download.expectedHashMatched: true` means a pinned catalog hash matched; `null` means the recipe had no pinned hash. Moving vendor download URLs can therefore produce a different version on a later run. The current installer supplies `Y` for ordinary disk-image license prompts under the installation authorization given for this project.

Quit the selected app normally, then start its supervised session:

```sh
node scripts/pipe-compatibility-session.mjs bruno
```

Wait for the JSON `ready: true` response. It includes the owned PID, sanitized target list and report path. The verifier refuses an already-running main process, launches the selected executable with `--remote-debugging-pipe`, and requests a temporary user-data directory. **Profile isolation is not guaranteed:** an app can use other existing state. The pipe belongs to this launch; this workflow does not open a TCP debugging port or attach to an arbitrary running app.

For the installed MongoDB Compass, use the same workflow with its fixed slug:

```sh
node scripts/pipe-compatibility-session.mjs compass
```

The harness automatically adds Compass's documented `--ignoreAdditionalCommandLineFlags` parser option; do not supply arbitrary extra flags. This adapter exists in both harnesses, but the two successful CSS confirmations used the pipe. They selected the welcome modal's **Start** button with `button.leafygreen-ui-da5f2u`; revalidate the selector and preview on every new launch. See [MongoDB's option documentation](https://www.mongodb.com/docs/compass/settings/command-line-options/) and the [two-run confirmation](../output/compatibility/compass/diagnostics/2026-09-05T22-59-41.159Z/adapter-confirmation.json).

Ownership checks use the kernel executable path, user and process start time. They do not infer exit from an app's displayed `ps` name: Compass changes that name, which caused an earlier incorrect cleanup claim. An identity-read failure stops the operation rather than granting ownership or proving exit. The confirmation links six kernel audits around Compass's two fresh trials.

Enter one JSON command per line in that same terminal, waiting for each response. Replace `TARGET_ID` with an explicitly chosen `page` or `webview` ID from the current list:

```json
{"command":"targets"}
{"command":"buttons","targetId":"TARGET_ID"}
```

`buttons` returns bounded structural metadata: tag, ID, classes, type, role and layout box. Its default query includes buttons, elements with a button role, submit inputs and links. `matches` counts every selector match; `candidates` includes the visible candidates examined, and `truncated` reports an incomplete examination. Select the intended surface and control yourself; do not assume the first target or first candidate is correct.

Build a selector from the observed structure, then validate it without applying CSS. In the commands below, replace `SELECTOR_FROM_OBSERVED_METADATA` with that selector, escaping any quotes as JSON requires:

```json
{"command":"buttons","targetId":"TARGET_ID","selector":"SELECTOR_FROM_OBSERVED_METADATA"}
{"command":"preview","targetId":"TARGET_ID","selector":"SELECTOR_FROM_OBSERVED_METADATA"}
```

Require `matches: 1` and one intended visible candidate. Preview captures `preview-N.png` without creating a stylesheet or initializing the trial baseline. Open the returned image path and verify the actual control and its label or icon. If startup is still moving it, allow it to settle and repeat the read-only checks before applying. A layout box alone does not prove a recognizable control is rendered. Stop if the surface is ambiguous or the preview is blank. Preview is available only before a CSS trial is initialized.

Apply the fixed cosmetic rule, inspect its computed appearance, restore it, and stop:

```json
{"command":"apply","targetId":"TARGET_ID","selector":"SELECTOR_FROM_OBSERVED_METADATA"}
{"command":"inspect"}
{"command":"remove"}
{"command":"stop"}
```

The fixed rule sets a green background (`rgb(22, 163, 74)`), white text and no background image. The harness records the original values and checks the target's identity, type and URL throughout the trial. It captures `before.png`, `green.png` and `restored.png` in `output/compatibility/<slug>/pipe/<timestamp>/`. It checks signing and the bundle fingerprint before launch, while styled and after cleanup. The commands do not click the control or invoke its service action.

Review all three PNGs and the completed `report.json`. A full visual result requires the same recognizable control to appear normally, turn green, and return to its original appearance. Also require `css.matchesExpected`, `css.matchesOriginal`, `activeUnchanged`, `unchanged` and `cssPass` to be true, with no errors. A computed-style pass with a blank crop is incomplete. A visible color change with a failed computed restoration is also incomplete.

Save a `visual-review.json` beside the report with the review time, app/version, selector, control, screenshot filenames, actual observations and `visualPass`. Set `visualPass: true` only after inspecting all three images; explain any incomplete result. Preserve earlier attempts. These artifacts under `output/` are gitignored, so retain them with the handoff.

`stop` clears the trial stylesheet, detaches, closes the pipe and stops the owned child. If normal termination takes too long, the harness records `forcedOwnedChildStop` and uses its owned-child fallback. It removes the temporary profile only after process exit. Check `processExited`, `temporaryProfileRemoved`, `launch` and any cleanup errors before calling the run complete. The installed app is retained. On a command error, record the limitation and send `stop`; unsupported startup or transport should remain an incomplete result rather than trigger unrecorded fallback attempts.

Claude's earlier startup-flag attempts were refused, but its normal UI-enabled main-process inspector now supports the fixed CLI CSS proof described in [Claude's guide](CLAUDE-DEVELOPER-MODE.md). Three trials passed, including one on a fresh normal 1.46388.4 process. Developer Mode persisted across restart; the inspector needed menu activation again. The final app and inspector were closed normally, while Developer Mode remains enabled as the supported persistent setup. All CSS application, removal and capture used the CLI, with fixed main-process JavaScript and read-only renderer checks. The generic pipe harness and Compass parser adapter do not implement that route. Evernote's tested production build still explicitly refuses remote debugging, with no supported external route established.

Rancher Desktop has one **fixed read-only image exception**:

```sh
node scripts/pipe-compatibility-session.mjs rancher --rancher-image
```

This command requires the separately prepared, catalog-hash-matched image at the exact proof mount and verifies that it is read-only. It neither downloads nor mounts the image, and it does not constitute permanent installation. Use the [source preparation report](../output/compatibility/rancher/image-test-preparation.json) together with the harness report; it records image identity, framework version, source signing and separate image/process cleanup. The saved trial's image and mount have already been removed, so this command is not currently ready to rerun without fresh reviewed preparation. Its lifecycle outcome belongs in the live results even when color application and restoration were observed. This exception is not a general disk-image mounting workflow.

The generic pipe client's allowlist provides metadata, DOM/CSS inspection and screenshots; its commands do not evaluate renderer JavaScript. Claude's separate adapter does execute fixed main-process JavaScript and read-only renderer checks. Neither workflow establishes arbitrary production-extension JavaScript, injected event handlers, audio playback or Chrome-extension APIs.
