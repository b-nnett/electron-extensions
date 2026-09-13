# Claude native CSS and JavaScript product proof

**Passed on 13 September 2026:** Claude Desktop **1.52386.6** completed **25 checks in 108.554 seconds** with Extensions Anywhere **0.1.12/build 13**, on the exact new-chat renderer `https://claude.ai/new`.

The native test uses the real importer/manager APIs, a generated signed helper and the packaged broker/runtime. A separate isolated library and in-memory Dock preserve the user's actual extension library and Dock. The test adapter is not the manager GUI: this proves native product behavior, not a GUI file-picker interaction or physical Dock installation.

## What passed

| Check | Observed result |
| --- | --- |
| Import and launch | A mixed manifest imports disabled without starting a helper. Enabling dispatches the generated alias with its sealed runtime and isolated library. Claude starts normally, then status waits honestly for manual debugger setup. |
| CSS and JavaScript | The imported script creates exactly one new button. Imported CSS makes it green, `rgb(22, 163, 74)`; its bounds, visibility and center hit target are verified. A harmless document outline-offset marker changes from the measured `0px` baseline to `3px`. |
| Real click and logs | A native accessibility click changes the button count to 1 and produces an extension/file/revision-attributed console event read through the native runtime-log reader. |
| Disable and rapid re-enable | Disable removes the owned DOM and restores the independent CSS baseline. Re-enable installs exactly one fresh visible button with count 0. |
| Replacement | Removing the old package and importing changed source produces a distinct attributed revision, one replacement button and the new `7px` CSS marker. |
| Native reload | **Claude View → Reload** produces a new document. One green button returns automatically; another real click changes its count to 1 and produces the expected attributed log. |
| Removal and session cleanup | Removing both test packages clears their DOM, CSS and runtime state. Disabling the last preserves the exact Claude/helper processes. Explicit helper stop cleans scripts/styles, detaches its owned renderer debugger and inspector client, then exits successfully. |
| Target survival | An independent kernel observation confirms the same Claude process remains alive after helper exit; the broker did not request target termination. |
| Target integrity | All **3,571 fingerprinted bundle entries**, the vendor signature and checked executable/archive resources match before, during and after cleanup. |

The operator visually reviewed the green button before and after reload and clicked it through native accessibility. Those CUA screenshots are displayed in the conversation only; no standalone screenshot files are claimed. The passing observations explicitly require a visible, hittable proof button, rather than relying only on an off-screen DOM node or CSS acknowledgement.

After the test and helper cleanup, the operator used **Claude → Quit Claude**. A separate receipt confirms that the exact test process was absent and port 9229 had no listener. Developer Mode itself remains a setting controlled by Claude; disabling extensions alone does not close the main debugger.

## Evidence and identity

Evidence directory: `output/release-review/2026-09-13/native-claude-package-999885C9-9830-4645-9DE1-4E92E886DBE8`.

- [Native result and all 25 checks](../../../output/release-review/2026-09-13/native-claude-package-999885C9-9830-4645-9DE1-4E92E886DBE8/native-report.json)
- [Native test log](../../../output/release-review/2026-09-13/native-claude-build13-visibility-e2e.log)
- [Operator visual review](../../../output/release-review/2026-09-13/native-claude-package-999885C9-9830-4645-9DE1-4E92E886DBE8/operator-visual-review.json) and [normal-quit receipt](../../../output/release-review/2026-09-13/native-claude-package-999885C9-9830-4645-9DE1-4E92E886DBE8/operator-normal-quit.json)

| Identity | Value |
| --- | --- |
| Claude bundle | `/Applications/Claude.app`, `com.anthropic.claudefordesktop` |
| Vendor CDHash | `ac04296667b6387e012c2b4f99008bca914e17a4` |
| Vendor full-bundle fingerprint | `99b4b7ce4abbf899c3480bd3d015a0e09d9a2f55f78cc7e4c46b3a5b5a40d571` |
| Manager executable SHA-256 | `3a0257936d85e945ce455cbbc287cf9a30ed37c892112ea1f521518d844dde0f` |
| Packaged runtime digest | `4956abfaf32dcf590842d031b8bdc07fe230f5e211f58612c80ea3973026a72f` |

The manager executable matches the frozen notarized build-13 receipt. Apple accepted submission `5d752ea3-1a91-4252-b1ba-ada9294025eb`; stapling and Gatekeeper passed. The prepared release archive and signed feed also verify, but publication is separate from this product proof.

## Setup and limits

Enable **Help → Troubleshooting → Enable Developer Mode** once when needed, then **Developer → Enable Main Process Debugger** after each app launch. The broker never enables it automatically or edits private preferences. Its fixed main-process bridge relays bounded commands to an isolated renderer context for imported scripts. The main debugger still exposes Claude's full process to local software; this is not a permissions sandbox. See [setup and cleanup](../../CLAUDE-SETUP.md) and the [extension lifecycle contract](../../EXTENSION-FORMAT.md).

This pass covers the exact new-chat page and installed version above. It does not prove conversation/project routes, arbitrary windows, other versions, unattended debugger activation or Chrome extension APIs. No messages or account actions were performed. Source logs and observer measurements concern the owned proof controls. Local `output/` evidence is retained privately and is not included in the public source checkout.

## Earlier attempts remain separate

- `13A67510-ABBE-44C0-BF11-93C111D5B125` failed the test's required normal-launch ownership checkpoint after operator app selection caused an earlier launch. It is not a successful product trial.
- `D5E7603B-CE59-4183-8F66-1E691D84B2FB` on build 12 exposed a real rapid-toggle cache race after CSS, a real click/log and disable passed. Build 13 corrects revision-cache invalidation around asynchronous source replacement; the successful run above exercised re-enable again.
- `EF98931A-1F82-454A-9764-082206336953` on build 13 did not establish visible button/click behavior and remains failed. The successful later trial used the **same manager executable, packaged runtime digest and Claude version** with explicit visibility/hit-target observations. There is no evidence here for a wrong-renderer or version-specific product defect, and the target route was not changed for the passing run.
