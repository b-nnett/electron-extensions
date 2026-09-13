# VS Code imported CSS and JavaScript product proof

**Passed on 13 September 2026:** manager build 9 (0.1.8), Visual Studio Code 1.137.0, macOS 27 / Apple silicon. The complete native test passed 19 checks in 65.72 seconds.

The test imported a manifest through the real `ImportedExtensionPackage` and `ExtensionManager`, generated and verified a signed launcher containing the packaged runtime, and opened its Finder alias through the manager's Open App action. It used an isolated extension library and an in-memory Dock; it does not claim a GUI file-picker interaction or a physical Dock click.

| Behavior | Observed result |
| --- | --- |
| Import and enable | CSS and JS source preserved; native profile accepted and persisted the package |
| Launch | Exact original VS Code executable launched with its normal renderer-debugging flags |
| CSS and JS | One injected green button, real computed color and an independent document CSS marker |
| Click and logs | Pointer click ran the JS handler; native log reader returned extension/file/revision-attributed output |
| Disable | Button removed and independent CSS property restored |
| Re-enable | One fresh button and handler |
| Replace imported source | Old button removed; new source revision identified in logs |
| Reload | Operator used VS Code's **Developer: Reload Window** command; CSS and one fresh handler returned automatically, with increasing log sequences |
| Remove last extension | Authored DOM and CSS removed; isolated library records cleared |
| Helper shutdown | Exact owned helper exited normally in 2.08 seconds; its cleanup left VS Code running |
| Target integrity | All 2,784 bundle entries and strict vendor signing matched before, during and after |

[Complete native report](../../../output/release-review/2026-09-13/native-vscode-package-BF70F47E-B08E-4F49-8FD3-D58EA7DC9CE6/native-report.json), [test log](../../../output/release-review/2026-09-13/native-vscode-build9-integral-e2e.log), [authored-button crop](../../../output/release-review/2026-09-13/native-vscode-package-BF70F47E-B08E-4F49-8FD3-D58EA7DC9CE6/01-authored-button.png).

The unchanged bundle SHA-256 was `8827ecfe36352085c492d419bc15fa98af368442eb7d3f21ed4e146f48b1085a`; CDHash was `c3a02d5a51a5934ed3e7d3aa81b1a273ccf01255`. After the test finished, the operator quit this newly launched VS Code normally. The UI reported six unsaved editors before and after its normal reload; the test did not open, edit, save or discard those files.

## Failures that informed the implementation

Failed runs remain available. They are not counted as passes.

| Run | Finding | Resolution |
| --- | --- | --- |
| Build 6 | A late-discovered owned debug port was missing from native session metadata | Publish it after listener/process ownership verification |
| Build 7, first run | Operator missed the native reload checkpoint | Add a prompt checkpoint file and monitor it during the live run |
| Build 7, second run | Reload failed when the broker looked for a fixed vendor Manage control | Mixed runtime now validates the owned process, selected renderer and stylesheet readback without depending on a proof control |
| Build 8 | Launcher waited in file open for macOS Documents-folder authorization | Put test launcher/library/session files in isolated Application Support, matching production; keep reports in the repository |
| Build 9, first run | CSS was active, but Chromium reported fractional outline offset `3.14px` as `3px` | Use distinct integer pixel markers for portable computed-style assertions |

VS Code installed its own updates during ordinary quit/reopen between earlier runs: 1.136.2 and then 1.137.0 were observed. Every trial records its own integrity baseline; hashes from different versions were never combined. No target bundle was patched or signed by this work.

## Reproduce

With VS Code and its extension launcher closed, first build the manager, then run:

```sh
EA_RUN_NATIVE_VSCODE_PACKAGE_E2E=1 \
EA_NATIVE_PROOF_DIAGNOSTICS=1 \
EA_NATIVE_PROOF_MANUAL_RELOAD=1 \
swift test --package-path macos --build-system native \
  --filter FixtureJavaScriptIntegrationTests/testOptInNativeVSCodePackageLifecycle
```

Watch the new report directory for `reload-request.json`, then use **Developer: Reload Window** in the test-launched VS Code window within the checkpoint deadline. Do not substitute raw `Page.reload`, which does not preserve the editor's normal hot-exit lifecycle. Live artifacts and matching receipts remain under `~/Library/Application Support/Extensions Anywhere Native E2E/`; the actual user's extension library and Dock are not used.

Coverage is the exact packaged VS Code workbench root. It excludes webview contents, multiple matching windows and unrelated application processes. The run demonstrates imported CSS/JS through a real third-party product integration; it does not establish every other app's compatibility.
