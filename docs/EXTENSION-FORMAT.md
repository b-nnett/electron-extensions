# Extension packages

An extension is a folder containing a JSON manifest and its referenced CSS and JavaScript files. Select the manifest in **Add Extension** for a discovered app. Names, descriptions, and versions come from the manifest; the import sheet has no metadata inputs.

Imported CSS and JavaScript run through the native manager, signed launcher and packaged renderer controller. The current source configures the engine for all 47 catalog profiles, plus built-in Style Lab, experimental ChatGPT and assisted Claude. Full native lifecycle checks passed for Style Lab, the real VS Code workbench, Figma 126.8.18’s login page and Claude 1.52386.6’s new-chat page. Figma’s files browser and editor routes are configured on the exact `https://www.figma.com` origin but remain unverified. Claude’s exact new-chat integration requires [manual debugger setup](CLAUDE-SETUP.md) after each launch; its [25-check product proof](release-review/2026-09-13/native-claude-product-proof.md) passed on build 13. ChatGPT's main-page JavaScript and the remaining 45 catalog profiles have no new live JS product proof. See the [current coverage table](CURRENT-COVERAGE.md) before choosing a target. Packages can be saved disabled wherever execution is unavailable; importing source does not itself establish compatibility.

```text
my-extension/
  manifest.json
  styles/
    base.css
    buttons.css
```

```json
{
  "manifest_version": 1,
  "name": "My extension",
  "description": "Describe what your extension changes.",
  "version": "1.0.0",
  "css": ["styles/base.css", "styles/buttons.css"],
  "js": []
}
```

This is the Extensions Anywhere manifest format, not Chrome's extension manifest or a promise of Chrome extension APIs. `manifest_version` must be the integer `1`. `name`, `description`, and `version` are required, nonblank strings; `version` is metadata, with no semantic-version syntax enforced. `css` and `js` are optional arrays that default to empty, but at least one source file must be listed. Both arrays can contain multiple files. Files may live in subfolders; use relative paths such as `styles/buttons.css`.

The selected manifest must be a regular `.json` file. Source files must be regular UTF-8 files with the corresponding `.css` or `.js` extension. Referenced files must remain inside the manifest folder after resolving symlinks. Absolute paths, parent-directory traversal, missing files, duplicate references, and links outside the folder are rejected. In-folder symlinks are allowed when their resolved source remains valid.

| Limit | Import/library format | Enabled runtime selection |
| --- | --- | --- |
| Manifest | 64 KiB | Uses imported records |
| Each source | 2 MiB | Must also fit the aggregate runtime limit |
| Sources per package | 32 | 32 CSS/JS files per enabled record |
| Total imported source per package | 8 MiB | Up to 64 enabled records per app |
| CSS | UTF-8 `.css` files | 64 KiB combined across enabled records, including joining newlines |
| JavaScript | UTF-8 `.js` files; mixed packages allowed | 256 KiB combined for a configured mixed profile; rejected explicitly by CSS-only profiles |

Import copies metadata and source text into `~/Library/Application Support/Extensions Anywhere/library.json`. It does not keep a live reference to the source folder: editing or deleting the original files does not update the imported copy. Import the changed package again and remove the superseded record when appropriate; in-place package updating is not implemented. Existing single-file library records remain readable through their legacy fields.

The manager stores extension assignments and enable preferences per app. A saved `Enabled` preference is not proof that an app has an active runtime connection. Apps without a configured launch profile retain their records and state that running their extensions is not implemented yet. The importer offers **Save Disabled** when a package cannot run with the current target/profile or aggregate source limits. ChatGPT's adapter checks stylesheet readback and script lifecycle state; the named Hide Sidebar Voice Button extension also requires its Voice-hidden check. Its new JS path is configured and tested at source level, not live-verified in the installed app. Details separates Library activity from attributed Runtime logs for that extension's current launcher session.

## CSS order, scope, reload, and removal

Each broker reads enabled records for its exact app identifier in stored library order. Within a package it uses the manifest's CSS file order. It joins those texts with newlines into one inspector stylesheet; the legacy copy of the first source is not added twice. There is no ordering control in the UI yet. Among otherwise equal declarations, later rules take precedence under the CSS cascade; specificity, importance, and other cascade rules still apply.

Selectors are not automatically rewritten or isolated. A broad `button` rule affects matching buttons on the selected page. Use a specific selector such as `#signal-button` for the fixture when that is the intended scope. Profiles validate their selected renderer. Launch arguments remain profile-specific. Slack, Notion and Figma accept paths on their exact configured HTTPS origins; other profiles retain their configured page patterns. An accepted origin does not establish successful execution in every signed-in workspace, window, iframe or shadow root. Figma’s full live proof covers login only.

Each source should be complete, valid CSS. Imports are bounded text validation, not a CSS syntax checker, and concatenation does not repair an unfinished comment or rule. Asset files are not copied, and source filenames become labels in the library. Relative `url(...)` and `@import` references are therefore not resolved against the original package folder by this system. Asset packaging and stylesheet dependency resolution are not implemented.

While connected, the brokers check library revisions approximately every 750 ms. For Style Lab, a changed selection first removes the previous combined stylesheet, checks the fixture's baseline, then applies the new combination. ChatGPT replaces its own stylesheet text and verifies readback. Disabling one extension recomputes the remaining enabled CSS; disabling the last clears the combined stylesheet. Automatic reload/reapplication has passed in Style Lab and the VS Code workbench; live ChatGPT reload remains unverified because the optional check refused multiple packaged-app targets before requesting a reload. Session evidence must verify these behaviors for a particular run.

Mixed-runtime cleanup disposes registered script resources before removing CSS. Style Lab then stops its owned child; catalog and ChatGPT brokers do not request target termination during ordinary cleanup. Process survival depends on the transport: in Figma's passing run, ordinary disable kept the exact app/helper alive, while explicit helper stop cleaned scripts/styles and closed its pipe, after which Figma exited normally. If a target exits first, its document state ends with the process and explicit restoration evidence may be unavailable. ChatGPT's earlier CSS [cold-start application](../output/chatgpt-adapter/live-restart-result.json), [disable](../output/chatgpt-adapter/live-disabled.json), and [re-enable](../output/chatgpt-adapter/live-reenabled.json) checks passed with unchanged signatures; these predate imported-JS support and are not a live mixed-runtime proof. An already-running configured app normally prompts with a native **Restart / Not Now** alert. Claude’s assisted profile instead adopts its exact verified running process and waits for the user-enabled debugger; it does not restart that process just to connect. Restart requests a normal quit and reopens only after the exact selected process has exited; Not Now leaves it running. These operations do not edit target bundles or signing. See [Dock launching and verification](DOCK-LAUNCHING.md).

## JavaScript lifecycle

List files in `"js": ["scripts/main.js"]`; CSS and JS may coexist in the manifest. A mixed runtime installs the selected CSS before loading scripts. Within each extension, JS files execute in manifest order. Extensions have independent lifecycle queues; do not depend on execution order between different extensions.

The [Claude proof](release-review/2026-09-13/native-claude-product-proof.md) passed 25 checks with build 13. The [Style Lab native proof](../output/release-review/2026-09-13/native-fixture-package-AE0BE93F-5E3F-4AE8-B522-6A92FA96230E/native-report.json) passed 22 checks. The [VS Code proof](release-review/2026-09-13/native-vscode-product-proof.md) passed 19, and the [Figma login proof](release-review/2026-09-13/native-figma-product-proof.md) passed 22, including real clicks, attributed logs, disable/removal, source replacement and automatic reload. All use actual manager APIs and generated helpers with isolated libraries and an in-memory Dock; they do not claim GUI import clicks or physical Dock installation.

The manifest stays at version 1. CSS and JS retain their separate ordered arrays; no background worker, `permissions`, Chrome API, native Node access, npm import or package asset loader is added by this contract. Authored JS files are browser-script function bodies, evaluated in listed order with fresh extension state for each document/revision. A successful file is not evaluated again merely because the manager polls an unchanged library. Ordinary script return values are ignored; cleanup must be registered explicitly.

The lexical API is `ea`: a function argument available to each authored file, rather than a property added to the application's global object. It contains:

| Member | Contract |
|---|---|
| `ea.id` | The immutable library record ID for this extension instance. Use it to scope authored element IDs when two copies of a package are installed. |
| `ea.signal` | An `AbortSignal` belonging to the current extension revision/document. Register event listeners with `{ signal: ea.signal }` where supported. It is aborted when disposal starts. |
| `ea.onDispose(callback)` | Register cleanup before making a side effect. Callbacks run once in reverse registration order across that instance's files. Synchronous callbacks are recommended for DOM cleanup; Promise-returning callbacks are awaited cooperatively. One failing callback is reported and does not prevent the remaining callbacks from being attempted. Registration returns `undefined`; a returned script function is not a disposer. |

Disable, removal, changed revision and orderly shutdown request disposal. The owned native proof verifies manager-driven toggles, source replacement through re-import/removal and shutdown; core tests cover same-record revisions and disposal failures. Replacement must dispose the old instance before starting its successor. Failed installation cleans registered resources and reports the failed file. Failed disposal still attempts every callback and blocks that affected extension's replacement until a fresh document/runtime. Other extensions can continue. Retrying disable does not clear the block.

Register up to 256 disposers per extension generation, during loading or active execution, including after asynchronous work while `ea.signal` is still un-aborted. Registration after disposal starts throws. The core aborts the signal before invoking disposers and defaults to a shared 3-second cleanup deadline. After that deadline, it still attempts remaining callbacks with a minimum 1 ms timeout race each. A rejected or timed-out callback marks cleanup incomplete; a timed-out Promise is not cancelled and may settle later. These timers cannot preempt a synchronous infinite loop. Installation is also cooperatively bounded, with a default 3-second deadline shared across its files; an unresolved initializer blocks replacement until a fresh document. Keep initialization and cleanup short.

Top-level navigation destroys the old document and its execution context. Context loss must not be presented as successful explicit cleanup. The earlier core proof manually initialized after reload; the later native product proof verified automatic reapplication, fresh button state and increasing session log sequences across reload. Old document objects must not be reused. Crashes and lost connections can still prevent callback execution.

Authors must remove nodes they inserted, disconnect observers, clear timers, abort owned requests where possible, and restore only changes they still own. DOM globals, storage writes, network requests, downloads and external actions cannot be generically undone. Abort is not a rollback of an already completed request. Avoid implementing work whose only safety depends on a cleanup callback always firing. This is a lifecycle mechanism, not a permissions sandbox or a guarantee that arbitrary scripts are reversible.

### Logging contract

The wrapper supplies a lexical `console` with `log`, `info`, `warn` and `error`, forwarding bounded diagnostic records associated with extension ID, filename and revision. It must not replace the application's global console or collect unrelated app logs. Runtime exceptions and disposal errors also produce attributed error messages; lifecycle state remains separate from console events, and library add/toggle records remain management activity.

Write short messages and explicitly chosen primitive values. Do not log page content, account data, tokens, full DOM nodes or arbitrary object graphs. Messages are capped at 4096 UTF-8 bytes, with an ellipsis on truncation; at most 32 arguments are rendered. Objects and functions become generic labels without enumerating object getters or calling `toJSON`. The core retains up to 500 recent events and 504 KiB of serialized event payload; older events are dropped. This is bounded recent history, not a complete audit log.

The native Details sheet separates **Runtime** and **Library** logs. Its new reader accepts only the selected extension's events from the current pointer-selected session's fixed `extension-logs.json`. The envelope has `schema: 1`, the exact `appKey`, a `sessionID` UUID matching the session folder, and an `events` array. Each event has `sequence`, `extensionID`, `fileName`, `revision`, `level`, `message` and an ISO-8601 `timestamp`. The reader rejects invalid metadata, symlinks, nonregular files, more than 500 events, or a file above 512 KiB. It refreshes while the sheet is open, off the main UI thread. App/session equality checks metadata consistency; they are not authentication or proof of a current connection.

The mixed packaged brokers persist real session logs, verified through the same native reader used by Details. The earlier controlled proof files remain separate evidence. The sheet shows **No runtime logs recorded** when its session log is absent, and library activity is never relabeled as script output. A filled Details sheet was not part of the automated manager-API proof.

### Required controlled-fixture acceptance evidence

The nine-check controlled proof passed styled button creation, attributed click output, duplicate-enable prevention, node/listener/CSS removal, fresh re-enable and changed revision, explicit reinitialization after reload, failed-install cleanup without disabling another extension, and unchanged fixture bundle/signature. Its manifest/source/core hashes identify the exact tested code. Synthetic core tests additionally exercise disposal errors and log limits.

Build 5's native proof subsequently passed actual package import through manager APIs, generated-helper launch, enable/disable, source re-import/removal, automatic reload, persisted attributed native log reading, normal owned-process shutdown and unchanged signing. Its in-memory Dock verifies bookkeeping, not real Dock installation. GUI import clicks and a filled Details sheet remain separate UI verification. Other app/version coverage requires its own evidence; the fixture does not establish broader compatibility.

Try the [Green buttons example](../examples/green-buttons/manifest.json).

## Create Extension page

**Create Extension** is pinned below the sidebar's scrolling app list. The Add Extension sheet also offers **Create your own**, which opens the same page with the selected app as context. The page shows a valid manifest example and has a **Copy Instructions** button.

Describe the extension and choose a project folder to open a task in an installed coding app. Detection checks known bundle identifiers and registered schemes, including native apps. Launches target the selected application explicitly, and only happen after clicking **Open Task**. Copied instructions and task links share the same authoring prompt, including the selected app's bundle path and candidate `Contents/Resources/app.asar` path.

Before authoring, inspect the target's renderer sources read-only to identify the relevant component markup, selectors, styles, event behavior, and state. If extraction is needed, extract only a copy outside the installed app. When `app.asar` is absent, check `app.asar.unpacked` or equivalent renderer assets; report unavailable sources rather than guessing their contents. Record the app version, inspected source paths, and selector assumptions with the extension. Source inspection informs implementation; it does not establish runtime compatibility.

Write only the extension's files in the chosen project folder. Leave the target bundle and its signing unchanged; the authoring instructions do not request attachment to the running app.

The documented integrations open prefilled drafts, requiring a send action in the destination app:

- Codex accepts a prompt and workspace path. [Codex deep links](https://learn.chatgpt.com/docs/reference/commands#deep-links)
- Claude Desktop accepts a Claude Code prompt and folder, with folder confirmation. [Claude desktop links](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)
- Cursor accepts a prompt in its current workspace, with no documented folder parameter on this route. [Cursor deep links](https://cursor.com/docs/reference/deeplinks)

Automatic submission is not implemented because these documented routes do not provide it. VS Code's project-only fallback is available in the discovery API but excluded from the agent list. No task route is assumed from an application's registered scheme alone.
