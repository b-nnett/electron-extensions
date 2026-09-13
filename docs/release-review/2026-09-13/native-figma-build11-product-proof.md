# Figma login CSS and JavaScript product proof — build 11

**Passed on 13 September 2026:** manager **0.1.10/build 11**, Figma **126.8.18**, macOS on Apple silicon. The complete native test passed **22 checks in 198.427 seconds**. Scope is Figma's exact login page; the files browser and editor are not covered.

The test imported a mixed manifest through the real manager/importer, generated a signed launcher, checked its runtime against the packaged manager and opened its alias. Library, source copies and session artifacts were isolated in Application Support, with an in-memory Dock. No user extension-library or physical Dock change was part of this proof.

| Behavior | Observed result |
| --- | --- |
| Import and launch | Disabled mixed import retained source; the generated helper used the exact Figma login profile and existing `--remote-debugging-pipe` launch |
| CSS + JS | One authored button, computed green `rgb(22, 163, 74)`, independent document CSS marker and attributed initializer logs |
| Real click | The operator clicked the authored button through native accessibility; its JS handler produced extension-attributed output |
| Disable/re-enable | Authored DOM removed and CSS baseline restored, then exactly one fresh button returned |
| Source replacement | Re-import/removal replaced the subject with a new attributed revision and updated CSS |
| Native reload | Home-tab context menu **Reload** created a new document; one green button and fresh handler returned automatically; another real click produced an attributed log |
| Remove final records | Subject and observer source removed; registered cleanup completed and stylesheet was removed |
| Ordinary disable | Exact Figma process and its pipe-owning helper remained alive |
| Explicit helper stop | Scripts/styles were cleaned before the pipe closed. Figma then exited with code 0; final kernel observation confirmed its absence |
| Target integrity | All 295 bundle entries and the strict vendor signature matched before, during and after |

The operator reviewed CUA screenshots of the green proof button against the white login page both before and after reload. Those images are in the conversation only; **no screenshot files were saved**. The broker's own diagnostic capture count is zero. The [operator review receipt](../../../output/release-review/2026-09-13/native-figma-package-95377EC3-14A7-4E10-9A17-00DE90CD5690/operator-visual-review.json) attributes these observations to the operator and links them to the native report hash.

The first Command-R attempt did not reload the page. The successful action was **right-click Home tab → Reload**, followed by clicking the returned authored button. The report confirms a changed document ID, one button, one click and the replacement `7px` CSS marker. A keyboard attempt alone was never counted as reload evidence.

[Complete native report](../../../output/release-review/2026-09-13/native-figma-package-95377EC3-14A7-4E10-9A17-00DE90CD5690/native-report.json) · [test log](../../../output/release-review/2026-09-13/native-figma-build11-retry-e2e.log).

The unchanged bundle SHA-256 is `f392784902574ecd958dd34e25d86a4766cd92036e70816962805c329fae1c69`; CDHash is `ab6de82bebc869ced7e783f379d7c6e7a987ef24`. No target re-signing, bundle patch, new page route or alternate launch flag was used.

## Reproduce and interpret

With Figma and its managed helper closed, build the manager, then run the opt-in native test:

```sh
EA_RUN_NATIVE_FIGMA_PACKAGE_E2E=1 \
swift test --package-path macos --build-system native \
  --filter FigmaJavaScriptIntegrationTests/testOptInNativeFigmaLoginImportedPackageLifecycle
```

Keep the desktop unlocked and follow both printed checkpoints: click only the authored proof button, then use the native Home-tab Reload action and click the returned button. Do not submit the login form. The harness records DOM/CSS/lifecycle evidence; it does not infer success from a screenshot.

Figma's pipe lifetime matters: ordinary extension disable leaves the app running, while explicitly stopping the pipe-owning helper can end Figma. This passing run records that exit honestly and left no test-launched Figma process alive. It does not promise process survival after pipe closure.

The earlier [build 10 partial result](figma-build10-partial-assessment.md) and first build 11 attempt `10E554E0-5105-4A81-8182-B82EC94D9528` remain unchanged. The latter reached real click, disable/re-enable and replacement before the operator's reload checkpoint timed out; it is an incomplete UI-assisted run, not evidence of a broken renderer runtime. Only the later 22-check run is counted as a complete pass. This proof does not claim manager GUI file-picker clicks, physical Dock installation, other Figma pages or other apps' compatibility.
