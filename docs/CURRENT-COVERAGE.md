# Current CSS and JavaScript coverage

Updated 13 September 2026. **Configured** means the current source has a profile-bound CSS/renderer-JS engine. **Product proof** means a particular packaged build and app version completed the recorded native import, launch and lifecycle checks. These are different claims.

| App or group | Configured scope | Current live evidence |
| --- | --- | --- |
| Style Lab | Built-in profile for our owned installed Electron fixture | **22 native product checks passed**, manager builds 5/6/7: mixed import, CSS, click handler, logs, disable/re-enable, replacement, automatic reload and cleanup. [Proof](release-review/2026-09-13/javascript-lifecycle-and-logs.md#build-5-native-product-proof). |
| Visual Studio Code 1.137.0 | Catalog profile, packaged workbench, ordinary TCP launch | **19 native product checks passed**, manager build 9. Real pointer clicks and native Reload Window; target bundle/signature unchanged. [Proof](release-review/2026-09-13/native-vscode-product-proof.md). |
| Figma 126.8.18 | Catalog profile, exact `https://www.figma.com` origin across paths, existing pipe launch | **22 native product checks passed**, manager build 15: CSS, real JS clicks, logs, disable/re-enable, replacement, native reload and cleanup. Ordinary disable preserved the app; explicit pipe closure ended it normally. The files browser/editor routes are configured but unverified. [Proof](release-review/2026-09-13/native-figma-product-proof.md). |
| ChatGPT | Built-in experimental profile, **one main app page** | Earlier live CSS application/disable/re-enable evidence. JS selection, controller and native policy are implemented/tested at source level; **no live JS proof or host restart for this change**. Multiple matching main pages are rejected. |
| Other 45 catalog apps | CSS + JS configured for their existing identity, transport and URL routes | **No new live JS product verification.** Historical CSS results remain tied to their recorded versions and screens. |
| Claude | Built-in assisted CSS + JS profile for exact `https://claude.ai/new`, through its user-enabled main debugger | **25 native product checks passed** on Claude 1.52386.6 with manager build 13, including visible CSS, real clicks/logs, rapid re-enable, replacement, native reload and cleanup. Target bundle/signature unchanged; helper exit preserves Claude. [Proof](release-review/2026-09-13/native-claude-product-proof.md) · [Setup](CLAUDE-SETUP.md). |

There are **47 catalog entries**: VS Code, Figma and the 45 apps below. Style Lab, ChatGPT and Claude are three separate built-in profiles, making 50 configured identities; this is not a 50-app verification result. The metadata deliberately retains `rendererRuntime.verification: "not-verified"`; a configured engine is not a completed compatibility matrix. 1Password remains excluded.

| Remaining catalog group | Apps |
| --- | --- |
| TCP — 6 | Slack, Notion, Signal, Postman, Obsidian, GitHub Desktop |
| Launch Services + TCP — 2 | Discord, Mattermost |
| Pipe — 37 | Tabby, Cursor, Bruno, balenaEtcher, Responsively App, electerm, GitKraken Desktop, VSCodium, Beekeeper Studio, Wave Terminal, Redis Insight, DbGate, MQTTX, MongoDB Compass, Insomnia, Another Redis Desktop Manager, Eclipse Theia IDE, Podman Desktop, Asana, ClickUp, Linear, Miro, Notion Calendar, Logseq, Anytype, AFFiNE, Standard Notes, SiYuan, Element, Rocket.Chat, Mailspring, Franz, FreeTube, LosslessCut, Rancher Desktop, Joplin, Antigravity |

The exact identities and URL patterns are in [runtime-profiles.json](../compatibility/runtime-profiles.json). Slack, Notion and Figma now accept paths on their exact HTTPS origins (`app.slack.com`, `app.notion.com` and `www.figma.com`). Source tests reject other origins, credentials and nonstandard ports. Only Figma’s login route has the full live proof recorded above; signed-in Slack/Notion/Figma routes are not newly verified. Other entries can also be limited to packaged pages or a configured local service. These profiles do not promise every window, iframe, shadow root or signed-in screen.

The successful product proofs use real manager APIs, generated signed helpers, packaged runtimes, isolated libraries and an in-memory Dock. Their check counts do not claim GUI file-picker clicks or physical Dock installation. See the [implementation/evidence guide](release-review/2026-09-13/full-css-js-release.md) and [extension contract](EXTENSION-FORMAT.md).

The latest native source checkpoint passed **301 tests with five live opt-ins skipped**, zero failures. The latest Node checkpoint passed **260 tests**; build 11’s earlier checkpoint passed 242. The earlier six-test focused authoring rerun is not added to the unique native count. App proof counts above are separate observations. The [actual manager 3→11 self-update](release-review/2026-09-13/real-manager-self-update.md) also passed; it adds no new vendor compatibility claim.

The separately requested 50-app sweep was stopped and stays skipped. The historical CLI result of 44 accepted CSS round trips out of 49 target apps is retained in the [expansion report](EXPANSION-VERIFICATION.md); it is not a current 44-app JavaScript claim. Local `output/` proof artifacts are retained development evidence and are not included in the public source checkout.
