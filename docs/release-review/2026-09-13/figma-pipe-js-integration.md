# Figma imported JavaScript pipe integration

The Node catalog now admits imported CSS and JavaScript for the exact existing **Figma login-page** profile. This does not add `/files`, editor, preview, or local-shell coverage. The signed vendor bundle and launch arguments are unchanged. Native policy parity is maintained by the security reviewer; the parent task owns Figma’s actual native product test.

`PipeCDP.enableRendererJavaScript(sessionId)` grants the four controller operations only to a session that this client attached after discovering a page/webview. The broker grants it after the owned process and unique selected target pass validation. The five Runtime console/exception/context events are routed only for granted sessions; they retain the session ID so the page adapter can filter them. Detach and close revoke the grant. Missing/true CSP bypass and universal-access parameters are refused. Browser-context, sessionless, other-session and arbitrary Runtime commands remain refused.

The Figma Node predicate pins its name, bundle ID, bundle/executable paths, pipe transport, empty-or-single ordinary pipe argument, exact current login regex and submit selector, and absence of an owned local service. JavaScript document checks additionally pin HTTPS `www.figma.com`, no credentials/port, and `/login` or `/login/`. Existing stored-source byte/count/UUID bounds, exact process identity, signature integrity, stylesheet readback, isolated unique context, lifecycle state and source-free log persistence remain shared with VSCode. Mixed sessions do not require that the diagnostic submit control exists to establish runtime health.

## Real owned-pipe proof

The [passing report](../../../../output/release-review/2026-09-13/imported-pipe-6f032783-dd73-4b8b-8340-d3598ae490b8/report.json) exercises the production pipe and shared controller against fixed `/Applications/Style Lab.app`, not Figma. It passed in approximately three seconds:

- CSS readback and computed button color, one imported button, idempotent enable, attributed click, and absent renderer Node globals.
- Attributed syntax failure while an independent healthy extension stays active, plus an attributed uncaught handler error.
- A real document reload creates a different unique execution context, automatically recreates one button, and preserves monotonic attributed logs.
- Disable, re-enable and controller disposal remove registered resources; explicit target detach revokes the capability.
- The owned child exits gracefully, its temporary profile is removed, and before/during/after bundle hash and signature match across all 265 fixture files.

The fixture refuses page-initiated navigation. CUA could not bind either the dist or installed fixture before their bounded waits expired, so no native Reload menu action occurred. The parent subsequently confirmed `CGSSessionScreenIsLocked=Yes`; these UI attempts do not establish an app or runtime failure. Those attempts are retained in `output/release-review/2026-09-13/imported-pipe-db859993-588c-43d4-9811-4ad25cb67199`, `imported-pipe-5365ea7f-cfc1-4348-aa8a-7181f37acf39`, and the later timestamped attempt directories. A separate installed-fixture attempt initially checked the app registry before readiness; moving that observation after the owned page appeared corrected the proof harness.

The successful [fixed fixture runner](../../../../scripts/testing/verify-imported-pipe-runtime.mjs) uses a **default-off** `allowOwnedFixtureReload` transport option. It permits only `Page.reload` on the explicitly granted attached session. The production broker never enables that option, and `catalogRendererPage` independently rejects `Page.reload`, including for Figma and VSCode. No vendor reload or UI action was performed by this reviewer.

The runner accepts no target/source/debugger arguments, checks the fixture’s fixed bundle ID, canonical paths and process identity, and refuses a pre-existing registered Style Lab instance. It records only owned fixture source attribution and protocol metadata; it does not persist unrelated application console output or screenshots.

Focused pipe/catalog regressions cover default-off grants, wrong/browser/detached sessions, session collisions, malformed responses, bounds, exact profile/route parity and production reload rejection. The final full Node run, including the explicit fixture-reload guard, passed **223 tests** with no failures or skips: [figma-pipe-final-node-tests.log](../../../../output/release-review/2026-09-13/figma-pipe-final-node-tests.log).

Figma remains **login-only and awaiting the parent’s live vendor product result** in this document. The owned fixture establishes transport/controller behavior, not Figma’s runtime compatibility.
