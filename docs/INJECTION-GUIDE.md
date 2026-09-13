# Verified runtime CSS guide

These instructions reproduce the existing proofs for nine installed macOS apps. All nine passed external programmatic CSS application and restoration with unchanged vendor signatures and bundle fingerprints. The production tools apply one fixed green stylesheet; they are not general extension loaders. Run commands from the repository root after `npm ci`.

| App / tested version | CSS transport and result | Verified control / selector | Production JavaScript | Controller GUI |
| --- | --- | --- | --- | --- |
| Slack 4.52.155 | TCP CDP — verified | Sign in to Slack: `a.p-ssb_landing__button` | Not verified | Not integrated |
| VS Code 1.135.0 | TCP CDP — verified | Continue with GitHub: `button.onboarding-a-signin-btn.primary` | Not verified | Not integrated |
| Notion 7.32.0 | TCP CDP — verified | Continue in Browser: `div[role=button].x1b7c0jy` | Not verified | Not integrated |
| Signal 8.26.0 | TCP CDP — verified | Need help? link: `a` | Not verified | Not integrated |
| Postman 12.26.5 | TCP CDP — verified | Create Free Account: `button[type=submit]` | Not verified | Not integrated |
| Obsidian 1.13.7 | TCP CDP — verified | Quick start: `.quick-start-container > button.mod-cta` | Not verified | Not integrated |
| GitHub Desktop 3.6.3 | TCP CDP — verified | Sign in to GitHub.com: `button[type=submit]` | Not verified | Not integrated |
| Discord 0.0.410 | TCP CDP — verified | Find or start a conversation: `button.fullWidth_a22cb0` | Not verified | Not integrated |
| Figma 126.8.18 | Pipe CDP — verified | Log in with browser: `button[type="submit"]` | Not verified | Not integrated |

Selectors apply to these observed screens and versions. The harness requires exactly one match; Signal's `a` selector was unique on its unlinked setup screen. It is not a selector for an arbitrary signed-in Signal screen. Discord used the existing signed-in home screen. The other controls were on login or initial setup screens. No service button was clicked by these CSS proofs.

## Start a TCP session

For Notion, Signal, Postman, Obsidian, or GitHub Desktop, quit the target normally, then run **one** corresponding command:

```sh
node scripts/compatibility-session.mjs notion
node scripts/compatibility-session.mjs signal
node scripts/compatibility-session.mjs postman
node scripts/compatibility-session.mjs obsidian
node scripts/compatibility-session.mjs github
```

The session launches that fixed app under `/Applications`, requests a temporary user-data directory, and discovers its debugging port. Profile isolation is requested, not guaranteed by every app. Wait for the JSON line with `"ready":true` before entering commands. It includes fresh page target IDs; use the intended login/setup page, not a worker or unrelated page.

VS Code's recorded pass used the separate owned launcher. In terminal 1:

```sh
node scripts/launch-compatibility.mjs vscode
```

Keep it running. Use its freshly returned app `pid` and `port` in terminal 2, replacing `PID` and `PORT`:

```sh
node scripts/compatibility-session.mjs vscode --existing-pid=PID --port=PORT
```

The launcher requests a temporary profile, a new window, and disabled extensions. After completing the CSS commands below, press Ctrl+C in terminal 1 to stop its owned app and remove its profile. The launcher otherwise has a 15-minute lifetime.

Slack's recorded pass used an already-running debugging session on its sign-in screen. Inspect the current main process and its listener, replacing `PID` with the current main PID:

```sh
pgrep -fl '^/Applications/Slack\.app/Contents/MacOS/Slack( |$)'
lsof -nP -a -p PID -iTCP -sTCP:LISTEN
node scripts/compatibility-session.mjs slack --existing-pid=PID --port=PORT
```

Use the current loopback debugging `PORT`. The session independently verifies the executable and exclusive `127.0.0.1` listener ownership. Do not reuse the historical PID or assume an ordinary Slack launch exposes an endpoint. Slack's existing-session CSS pass does not establish a verified fresh-launch recipe.

Discord passed after a macOS LaunchServices launch with its existing profile. Direct executable launches did not yield a stable attachment. Quit Discord normally first. Check that the example port is unused, then launch with the recorded options:

```sh
lsof -nP -iTCP:56176 -sTCP:LISTEN
open -a /Applications/Discord.app --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=56176
pgrep -fl '^/Applications/Discord\.app/Contents/MacOS/Discord( |$)'
```

If the first command reports a listener, choose another unused port. After startup, replace `PID` with the new Discord main PID and use the port selected above:

```sh
node scripts/compatibility-session.mjs discord --existing-pid=PID --port=56176
```

This preserves the existing profile; do not sign out to reproduce a login control. After the CSS session finishes, quit this diagnostic Discord launch normally to close its debugging endpoint. The [working launch report](../output/compatibility/discord/launchservices-followup.json) records the original observation; it does not isolate whether launch method or profile choice resolved the earlier failures.

## Apply and restore CSS in the TCP session

Enter newline-delimited JSON into the running session, one command at a time. Replace `TARGET_ID` with the fresh intended page ID. This example uses Notion's verified selector; for another app use its selector from the table.

```json
{"command":"targets"}
{"command":"buttons","targetId":"TARGET_ID"}
{"command":"apply","targetId":"TARGET_ID","selector":"div[role=button].x1b7c0jy"}
{"command":"inspect"}
{"command":"remove"}
{"command":"verify"}
{"command":"stop"}
```

`buttons` returns candidate element metadata. Confirm the intended control before `apply`; do not select an unrelated target merely to make a trial pass. `apply` creates its own runtime stylesheet with green `rgb(22, 163, 74)`, white text, and `background-image: none`, all with `!important`. It saves before/green screenshots and computed results. Check `matchesExpected: true` and `integrityUnchanged: true`. `remove` clears only that stylesheet and saves the restored screenshot; check `matchesOriginal: true`. The appearance comparison checks background color, text color, and background image; dimensions are recorded separately.

The session saves `report.json`, `before.png`, `green.png`, and `restored.png` under `output/compatibility/APP_SLUG/`. A rerun overwrites these filenames, so preserve previous evidence first if needed. Current sessions write `verdict: "pass"` only when application, restoration, active/final integrity, and error checks succeed. Older reports use different schemas; [COMPATIBILITY.md](../COMPATIBILITY.md) links the verified results.

## Figma: automated pipe proof

Quit Figma normally, then run:

```sh
npm run verify:figma
```

[verify-figma-pipe.mjs](../scripts/verify-figma-pipe.mjs) refuses an already-running Figma process. It launches only `/Applications/Figma.app` with `--remote-debugging-pipe` and a requested temporary profile. [pipe-cdp.mjs](../lib/pipe-cdp.mjs) communicates over the owned child's stdio 3/4 and a flattened page session. The proof requires one HTTPS Figma `/login` page and one submit button, revalidates the route, and automatically applies, checks, screenshots, removes, and checks the fixed stylesheet. It needs no Computer Use or DevTools UI.

The command exits successfully only when `verdict` is `pass`. It writes a timestamped directory under `output/compatibility/figma/pipe/`. The [latest verified run](../output/compatibility/figma/pipe/2026-09-05T16-02-59.975Z/report.json) restored the original black background, text color, no background image, and `233 × 48` dimensions. Both fresh verification runs preserved all 295 bundle files and the signature and removed their owned processes and temporary profile directories.

This pipe must be established when the app is launched; the implementation does not attach to an arbitrary already-running Figma instance. Login-page changes, signed-in pages, reload persistence, and controller GUI integration are unverified.

## Integrity and cleanup

[integrity.mjs](../lib/integrity.mjs) checks `codesign --verify --deep --strict`, CDHash, and a recursive SHA-256 fingerprint of physical bundle file contents, paths, modes, and symlink destinations. Successful trials compare the baseline before CSS, while the green stylesheet is active, and after cleanup. In existing-process mode, the session's baseline is taken before attachment, after the app has already launched. No target app is patched or re-signed.

Always send `remove` before `stop` to capture restoration explicitly. `stop`, input EOF, or interruption also attempts to clear the session's stylesheet. A session that launched its own app stops only that child and deletes its temporary profile after the child exits. Existing-process mode leaves the app running; separately stop an owned launcher or quit a diagnostic launch normally. Cleanup failures are recorded and prevent a passing verdict. Inspect the saved before/green/restored screenshots as well as the JSON result.

## JavaScript: owned fixture only

JavaScript injection, console handlers, and arbitrary Chrome extensions are **not verified in any of these nine production apps**. The existing JavaScript proof applies only to our owned Style Lab fixture:

```sh
npm run build:fixture
npm start
```

In the controller, launch Style Lab, choose **Add demo button**, and click **Log a message**. Its fixed handler calls `console.log`, and the controller displays the received event. **Remove demo button** removes it. [button-demo.mjs](../lib/button-demo.mjs) and [extensions/button-demo.js](../extensions/button-demo.js) implement this bounded fixture demonstration. `npm run verify` runs the fixture's fourteen-check proof, including CSS, the button handler, reload behavior, removal, and integrity. This is not a production-app JavaScript recipe.
