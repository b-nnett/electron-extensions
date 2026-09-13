# Figma build 10 partial-run assessment

Reviewed the saved native result, raw broker report/status, attributed extension logs, checkpoint 1 and isolated saved library. This review made no UI calls, launched no apps and did not modify the original evidence.

Evidence root: `output/release-review/2026-09-13/native-figma-package-C0E0F2DF-8498-49E2-AF0F-6E00E4165AB8`.

Session: `~/Library/Application Support/Extensions Anywhere Native E2E/native-figma-package-C0E0F2DF-8498-49E2-AF0F-6E00E4165AB8/Launchers/609db5f8c2de4c32a44fe1914559ecae348798f935547f76c5408ad0af4fda4f/Sessions/597C2325-6849-4A44-93B9-D3324781CB33`.

| Property | Result | Evidence |
| --- | --- | --- |
| Compiled native adapter | Executed | Manager 0.1.9/build 10; Figma 126.8.18 |
| Import and runtime binding | Passed | Disabled mixed import, isolated library, signed helper, helper Runtime digest equal to packaged manager Runtime |
| CSS and renderer JS initialization | Passed | Active revision 2, 401 CSS bytes, 1,973 combined JS bytes, both script states active |
| Actual authored DOM and CSS | Passed | Observer event 3: count 1, clicks 0, background `rgb(22, 163, 74)`, html outline offset `3px`; baseline event 1: count 0, outline `0px` |
| Extension-attributed logging | Initializer/disposer logs passed | Subject `main.js` emits `EA_FIGMA_READY initial`; observer and subject disposal events retain their own IDs/revisions |
| Real click handler | Not verified | No `EA_FIGMA_CLICK` event; checkpoint 1 timed out |
| Disable/re-enable/replacement/Reload/remove sequence | Not reached | The test exits its success path at the first click timeout |
| Registered disposal and stylesheet removal | Broker-confirmed | Both disposal events at 18:56:28.205Z; `jsCleanupVerified=true`, `stylesheetRemoved=true`, no broker errors |
| Figma remains open after helper exit | Failed/contradictory snapshot | `processExit` code 0 at 18:56:28.428Z occurs before final report; root later saw no Figma process |
| Target signing and full bundle fingerprint | Passed | Before/during/after valid, non-ad-hoc hardened signature; all 295 files hash identically |
| Runtime screenshots | None | Diagnostics disabled, captures 0, captured bytes 0 |
| Isolated saved preference cleanup | Passed | Both test records saved disabled; retained only in the uniquely named test library |

The checkpoint was created at **18:53:27Z** (19:53:27 local) and the run finished at **18:56:28Z**. The root separately reported a locked macOS screen session and a UI-tool timeout. This explains why there was no supervised click opportunity; it does not establish the unexecuted handler/reload checks.

The final cleanup record has a material timing contradiction. `cleanup.launchedAppLeftRunning=true` was sampled before the asynchronous final integrity check. The child then reported a clean process exit at **18:56:28.428Z**, while `finishedAt` is **18:56:28.539Z**. The broker still emitted `phase=stopped` with no errors and the native test accepted its stale survival boolean. Consequently the result's check text saying Figma was left running must not be treated as evidence of survival. The existing overall `passed=false` remains correct. The current data proves no explicit termination request; it does not prove why Figma exited.

Before claiming lifecycle success, the broker should reconcile process-exit evidence and the exact process identity again at final publication, and the native test should reject any recorded original-process exit and independently recheck that exact process after helper exit. A new unlocked-desktop run is needed for the real click and native Reload checkpoints. The previous evidence must remain intact rather than being relabeled as a successful run.
