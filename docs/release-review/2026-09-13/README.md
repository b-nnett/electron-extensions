# Release review and evidence — 13 September 2026

This directory preserves the **eight original independent NO-GO reviews** and the fixes and verification that followed. Those verdicts describe their original snapshots; they are not eight new verdicts on the current implementation. DMG/installer presentation was excluded from the reviews.

For current product behavior, use the [coverage table](../../CURRENT-COVERAGE.md), [CSS + JavaScript implementation/evidence](full-css-js-release.md) and [update runbook](../../AUTO-UPDATES.md). The user requires full CSS **and JavaScript**; the separately canceled 50-app sweep remains stopped, and unknown results are not passes.

## Current checkpoint

| Area | Recorded result |
| --- | --- |
| Style Lab | 22 native product checks passed on manager builds 5/6/7. [Proof](javascript-lifecycle-and-logs.md#build-5-native-product-proof). |
| VS Code 1.137.0 | 19 native product checks passed with build 9: CSS/JS, real clicks, logs, replacement, native reload and unchanged target signing. [Proof](native-vscode-product-proof.md). |
| Figma 126.8.18 | 22 native product checks passed with build 15 on its login page. Ordinary disable preserves Figma; explicit helper/pipe closure ended it normally. The current origin-scoped profile permits files/editor routes; they remain unverified. [Proof](native-figma-product-proof.md). |
| Other catalog apps and ChatGPT | All 47 catalog profiles and built-in ChatGPT have configured CSS/renderer-JS engines; the remaining 45 catalog profiles and ChatGPT have no new live JS product proof. Earlier ChatGPT CSS evidence is separate. |
| Claude | Claude 1.52386.6 passed 25 native product checks on build 13: assisted new-chat CSS/JS, visible real clicks/logs, rapid re-enable, replacement, native reload, cleanup and unchanged target integrity. [Proof](native-claude-product-proof.md) · [Setup](../../CLAUDE-SETUP.md). |
| Source tests | Latest native checkpoint: 301 tests with five live opt-ins skipped, zero failures. Latest Node checkpoint: 260 passed; build 11’s earlier checkpoint passed 242. The earlier six-test authoring rerun is not added to the unique count. |
| Signed candidate | Build 15 (0.1.14) is Developer ID signed, Apple Accepted, stapled and Gatekeeper accepted, with final Figma lifecycle verification complete. Its production ZIP and feed signatures verify for release 0.1.14. Earlier candidates and the build-11 updater proof remain separately recorded. |
| Updates | **Actual manager 3→11 self-update passed**: public download, replacement and fresh process at the same path, with no manual reopen. Library/Dock and restart/update choices preserved; one usage activation recorded. Release 0.1.14 uses the normal signed production feed; the bootstrap and updater test are historical artifacts. [Proof and limits](real-manager-self-update.md). |

The app proofs use real manager/importer APIs, generated signed helpers and packaged runtimes with isolated libraries and an in-memory Dock. They do not claim GUI file-picker clicks, physical Dock installation or all-app/window coverage. The actual updater trial used the existing user account and a user-assisted final confirmation; it does not claim clean-account coverage or byte-identical usage preferences. The release artifact is version 0.1.14/build 15.

## Original reviews

| # | Historical review | Original verdict | Follow-up |
| --- | --- | --- | --- |
| 1 | [Product and app coverage](01-product-coverage.md) | NO-GO | [Current coverage and implementation](full-css-js-release.md) separates configured engines from live proof. |
| 2 | [Lifecycle and Dock](02-lifecycle-and-dock.md) | NO-GO | [Helper transactions](helper-recovery-fix.md), [active-helper preservation](runtime-portability-follow-up.md), [JS helper upgrades](active-helper-javascript-upgrade.md). |
| 3 | [Extension security](03-extension-security.md) | NO-GO | [Screenshot privacy](privacy-fix.md), [session retention](session-retention.md), [lifecycle contract](../../EXTENSION-FORMAT.md). |
| 4 | [Portability](04-portability.md) | NO-GO | [Packaged runtime](runtime-portability-follow-up.md), [native identity](native-identity-fix.md), [relocated signed-package proof](packaged-runtime-proof.md). |
| 5 | [UX and accessibility](05-ux-accessibility.md) | NO-GO | [Draft/import/accessibility fixes](ux-fixes.md), [attributed Runtime and Library logs](javascript-lifecycle-and-logs.md). |
| 6 | [Test quality and evidence](06-quality-evidence.md) | NO-GO | Build-bound Style Lab, VS Code and Figma proofs above; canceled matrix results remain untouched. |
| 7 | [Updater](07-updater.md) | NO-GO | [Historical separate-harness installation](sparkle-local-install-test.md) and [actual-manager test](real-manager-self-update.md) retain distinct claims. |
| 8 | [Operations and recovery](08-operations.md) | NO-GO | [Missing-app management](unavailable-app-fix.md), [library recovery](library-recovery-fix.md), [retention](session-retention.md). |

The reviews were independent inspections, not eight complete live 50-app runs. Original reports and failed/partial trial evidence remain intact.

## Fixes and evidence limits

Normal brokers no longer capture screenshots implicitly; diagnostic captures require explicit opt-in and are bounded. Owned new-session retention preserves active, uncertain and legacy sessions. It does not retroactively clean historical manual files or impose a total disk cap. See [privacy](privacy-fix.md) and [retention](session-retention.md).

Packaged Node and the native process-identity reader remove the inspected Homebrew/Python runtime dependencies. Relocated signed-package proof and later mixed product runs verify their recorded paths; they do not establish another-machine, minimum-OS or Intel support. Helper replacement uses staged validation, atomic exchange and recovery receipts while preserving active/uncertain helpers.

The UI preserves unfinished authoring drafts, states selected-app capability before enabling, stores unsupported source disabled and keeps Runtime logs distinct from Library activity. Missing-app records remain manageable. Backup/export/restore is implemented with preserved originals and active-session refusal; its [recovery report](library-recovery-fix.md) identifies the recorded checks and remaining UI limits. Accessibility, manual Dock fallback, orphan Dock handling and historical-session cleanup retain their own evidence boundaries rather than becoming implied passes.

The shared [JS lifecycle core](fixture-extension-lifecycle.md) now has native product loader/log-producer evidence in the app proofs above. It provides cooperative cleanup, not a general permissions sandbox or rollback of arbitrary side effects. Debugger lifetime and cleanup remain app/transport-specific; Figma's observed pipe-close exit is explicitly documented.

The [archived checkpoints through build 4](review-checkpoints-through-build4.md) retain the earlier test counts, open-finding lists, updater results and original evidence links. They must not be read as current statements that product JS/logging is unimplemented or build 3 is the latest notarized candidate. Local `output/` artifacts are retained development evidence and are not included in the public source checkout. Historical hashes and screenshots belong to their recorded builds.
