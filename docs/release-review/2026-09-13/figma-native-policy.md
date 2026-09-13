# Figma native policy parity

The native manager, importer, monitor and generated helper now use the same Figma mixed-source eligibility predicate as `supportsCatalogJavaScript` in the catalog broker. This is a configured adapter boundary; it is not a claim that all Figma pages are supported or that a fresh live end-to-end proof has passed.

The profile must match all of these existing values: slug `figma`, name `Figma`, bundle identifier `com.figma.Desktop`, bundle path `/Applications/Figma.app`, executable `/Applications/Figma.app/Contents/MacOS/Figma`, pipe transport, and no owned local service. Arguments may be empty or contain `--remote-debugging-pipe` exactly once. No additional launch flags were introduced. The configured target is now `^https://www\.figma\.com/[^?#\r\n]*$`, retaining selector `button[type="submit"]` as the existing CSS proof control. The mixed runtime does not require that login control to exist. This permits the same HTTPS origin's signed-in routes while retaining exact host, no explicit ports or credentials, and single eligible page checks. Off-origin pages and local-shell routes remain outside this profile. This configuration change is not evidence that the files browser or editor has passed a live test.

`RuntimeExtensionSelection.catalogPolicy` controls both native selection and packaged helper decoding. It accepts mixed CSS/JS and JS-only records for this exact profile with the existing 64-record, 32-files-per-record, 64 KiB combined CSS and 256 KiB combined JS limits. Source validation and UUID/label/first-source rules are unchanged. The signed helper capability marker now includes the `figma` profile, so an older active helper cannot silently receive an enabled JS preference.

The UI summary distinguishes the configured `www.figma.com` renderer scope from completed live verification, which covers the login page only. The files browser and editor remain unverified. Other unconfigured vendor profiles retain their CSS-only or unavailable behavior. Target signing, installed bundles, user data and app processes were not changed by this source patch.

Tests cover the exact profile and negative path/identifier/executable/transport/argument/route/selector/service cases, native/helper mixed selection parity, byte limits, importer and enablement behavior, other-vendor refusal, and strict helper marker binding. On 2026-09-13 at 19:43 local time, `swift test --package-path macos --build-system native` passed the full native suite: 289 tests, 3 live opt-in tests skipped, zero failures. No Figma instance was launched by this test run.

After the exact-origin configuration and native copy update, the same native command passed **301 tests, 5 live opt-ins skipped, zero failures**, on 2026-09-13 at 20:46 local time. The tests require the exact declared origin pattern and reject stale login-only, unbounded, off-origin, HTTP, credential and explicit-port pattern substitutions. They also require authoring text to distinguish configured signed-in routes from login-only live verification. Evidence: `output/release-review/2026-09-13/native-origin-claude-full-suite.log`. No live Figma operation was part of this unit run, and `FigmaJavaScriptIntegrationTests.swift` still targets the login page specifically.

## Supervised native package proof

`macos/Tests/FigmaJavaScriptIntegrationTests.swift` adds an explicit opt-in test, skipped by normal unit runs. It uses a fresh library and generated helper under `~/Library/Application Support/Extensions Anywhere Native E2E/`, a memory-only Dock backend, and the current manager's packaged runtime. Existing Figma or Figma launcher instances cause refusal; the test does not quit them.

Run only when a supervising UI operator is ready and the current manager has been built:

```sh
EA_RUN_NATIVE_FIGMA_PACKAGE_E2E=1 swift test --package-path macos --build-system native --filter FigmaJavaScriptIntegrationTests
```

The test writes `next-action.json` in its reported evidence directory. Checkpoint 1 allows 180 seconds to click the authored green **Figma extension proof** button. After automatic disable/re-enable/re-import checks, checkpoint 2 allows 180 seconds to use Figma's native Reload command and click the returned proof button. The login form is not used.

A fixed imported observer extension reports only the proof button's DOM count, extension ID, click count and computed color, an independent CSS marker, and a fresh per-document token. It creates no debugger command endpoint. The test checks the newest attributed log snapshot rather than accepting an older matching event. This verifies native import/enable/helper behavior and supervised Figma UI actions; it does not claim that the manager's visible import sheet was clicked.

The test now distinguishes last-disable from explicit helper quit. Last-disable must preserve the exact live Figma instance and its pipe-owning helper. Explicit helper quit cleans scripts/styles and closes the debugging pipe, which can normally quit Figma; the broker must report the resulting process state truthfully. Its full-bundle fingerprint and code signature must match before, during and after cleanup. Vendor version/build and the complete broker report are retained alongside the isolated source/library receipts.

## First compiled live run: partial result

The test compiled and ran against manager **0.1.9, build 10**, and Figma **126.8.18**. The run's result is **failed/incomplete**, not full E2E coverage: [native-report.json](../../../output/release-review/2026-09-13/native-figma-package-C0E0F2DF-8498-49E2-AF0F-6E00E4165AB8/native-report.json). See [the evidence assessment](figma-build10-partial-assessment.md) for the cleanup qualification.

Native import, isolated helper/runtime binding, opening the generated alias, enabling mixed source, attributed initializer logs, and an actual single authored button with green computed background and the 3px CSS marker all passed. The run reached checkpoint 1. The first click never arrived, and its 180-second wait timed out. Click handling, re-enable, replacement, native Reload and post-reload handling remain unverified by this run.

The root independently observed the macOS session was locked (`CGSSessionScreenIsLocked=Yes`) and the UI tool could not complete its Figma inspection. The test itself records the checkpoint timeout, not the OS lock state. Interactive verification requires an unlocked desktop; no UI or app-launch actions were attempted by this subsequent evidence review.

The broker confirms registered JS cleanup, stylesheet removal, no explicit target termination request, zero runtime screenshots, and the same signed 295-file bundle fingerprint before/during/after. However, it also records Figma exiting with code 0 during final cleanup, contradicting its earlier `launchedAppLeftRunning=true` snapshot. The root subsequently observed no Figma process. **Figma remaining open is not a passed result.** The subsequent broker correction takes a late process observation, and the test now separately requires last-disable to preserve Figma while explicit helper-stop records the expected normal pipe-close quit. The corrected test compiled in the later 294-test native suite; its next supervised Figma run remains separate evidence.

## Later completed login-page proof

The corrected build-11 supervised native run passed, including the authored button's real click, native Reload and another real click, disable/re-enable/re-import, final removal and the corrected pipe-close cleanup checks. Its evidence is `output/release-review/2026-09-13/native-figma-package-95377EC3-14A7-4E10-9A17-00DE90CD5690/native-report.json`. This later result does not alter the failed build-10 receipt above. Both runs target the login page; neither establishes files-browser or editor coverage.
