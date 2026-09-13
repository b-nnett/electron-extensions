# Published release 0.1.14 — build 15

[Release 0.1.14](https://github.com/b-nnett/electron-extensions/releases/tag/v0.1.14) was published as GitHub Latest on 13 September 2026 at 20:21:38 UTC. It is neither a draft nor a prerelease. The public source and release tag point to commit `1588acfab82038e188e72191ce6b2d79c7afe86d`.

| Check | Result |
| --- | --- |
| Developer ID and notarization | Apple Accepted submission `6030c18d-2bf5-4b9a-8d80-d4cb3c430ced`; ticket stapled, strict/deep signature valid, Gatekeeper accepted. |
| Published ZIP | 42,142,598 bytes; SHA-256 `2f8075caf9f9c4efb0768cd3fd420e066f7ee690a1aa6aab3fef6a0ffe547906`. |
| Published appcast | 1,305 bytes; SHA-256 `c4e841f80ccdaed74de13494947c69b0e991309e90c625bef54267abca8f3a5d`. |
| Anonymous public downloads | ZIP and appcast bytes match the reviewed local assets; both Ed25519 signatures verify. Latest resolves to the exact published appcast. |
| Installed manager | `/Applications/Extensions Anywhere.app`, version 0.1.14/build 15; signature and Gatekeeper verified. Native SwiftUI window reviewed with its glass toolbar and saved extension state. |
| Production updater | Native **Check for Updates…** accepted the published feed and displayed “Extensions Anywhere 0.1.14 is currently the newest version available.” The separate actual manager 3→11 installation/relaunch proof remains the completed update round trip. |
| Source tests | 260 Node tests passed. Native suite: 301 tests, 5 live opt-ins skipped, zero failures. |
| Vendor product proofs | [Figma](native-figma-product-proof.md): 22 checks on build 15. [Claude](native-claude-product-proof.md): 25 checks on build 13. [VS Code](native-vscode-product-proof.md): 19 checks on build 9. Each retains its exact app version and page scope. |
| User state | Existing extension-library bytes unchanged; the existing ChatGPT app/helper/broker identities survived. No ChatGPT restart or live JS experiment was performed. |

The [coverage table](../../CURRENT-COVERAGE.md) distinguishes configured integrations from live verification. Figma files/editor routes, the other 45 catalog apps and ChatGPT's new JS path remain unverified by this release's product trials. Claude requires its own Developer-menu debugger setup after each launch and currently targets its new-chat page. No all-app, all-window, clean-machine, minimum-OS or Intel verification is implied.

Local receipts are retained at `output/releases/0.1.14-build15/public-verification/result.json`, `output/release-review/2026-09-13/build15-installed-manager.json`, `output/release-review/2026-09-13/build15-final-native-tests.log` and `output/release-review/2026-09-13/notarization/build-15/ready.json`. Raw captures, private state, signing credentials and diagnostic receipts are excluded from the public source. Older candidate artifacts and failed trials remain immutable local evidence.
