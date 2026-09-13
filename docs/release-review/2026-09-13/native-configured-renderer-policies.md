# Native configured renderer policies

The native manager/importer and generated helper now share mixed CSS/JavaScript validation for the 47 existing catalog profiles, plus the exact built-in Style Lab and experimental ChatGPT profiles. **Engine configuration is not per-app verification.** This change did not launch a vendor app, change any installed bundle/signature, expand a route or launch flag, or resume the 50-app sweep.

Each catalog entry declares exactly `rendererRuntime: {engine: "isolated-js-v1", verification: "not-verified"}`. Missing declarations retain legacy CSS-only selection. Null, malformed declarations, unknown keys, future engine values and claimed verification values are rejected. Existing catalog validation still limits installation/executable identity, transport, permitted flags, selectors, routes and the fixed owned-service exception.

`RuntimeExtensionSelection.Policy.catalogMixed(targetIdentifier:)` binds source selection to the identifier from that validated selected profile. An enabled record or caller cannot select a different app by substituting its stored identifier. VS Code and Figma retain their extra identity/document restrictions; those checks also recognize their known bundle identifiers and paths, so renaming a slug does not select a broader generic rule. Figma now declares HTTPS pages on exactly `www.figma.com`, with explicit ports, credentials, off-origin and local-shell pages excluded; its completed live verification still covers only the login page. Slack and Notion similarly declare only their existing `app.slack.com` and `app.notion.com` HTTPS origins. Declaring signed-in routes does not establish a live pass on those routes.

The built-in ChatGPT policy binds `com.openai.codex` at its existing `/Applications/ChatGPT.app` installation. The corresponding broker is being integrated separately for its fixed main-page route. The native UI labels its JavaScript configuration experimental and unverified in the installed app; no host ChatGPT process was launched or inspected by this work. CSS/voice behavior is not replaced by a different target route.

All mixed policies use the existing shared limits: 64 enabled records, 32 source files per record, 64 KiB combined UTF-8 CSS including separators, 256 KiB combined UTF-8 JavaScript, UUID IDs, contained source labels and consistent first-source fields. JS-only nonempty selections can launch. Source labels are not file paths read during execution.

Generated helpers now include `EARendererJavaScriptTargetIdentifier` in their signed Info.plist, in addition to the exact helper/profile and protocol marker. The installed helper's signature must be verified before trusting these fields. A missing or foreign target marker cannot establish compatibility, including for an older active helper that accepted JS before this marker existed. The existing native Restart / Not Now path preserves the old library until verified normal shutdown, compatible helper preparation and one captured-intent retry.

## Disable versus explicit helper quit

The native disable path saves the preference and restores the original Dock pin. It does not terminate the helper or broker. `LauncherMain` continues monitoring an active or disabled session, and the catalog broker continues watching the empty selection. Closing the manager window or stopping its monitor does not stop those independent helper processes.

Explicitly quitting a pipe-owning helper is a different operation: the broker cleans its scripts/styles and closes the pipe. The owned pipe proof recorded the target exiting normally with code 0 and no signal after that close. The Figma E2E test now checks both properties separately: last-disable must preserve the exact live target/helper; explicit helper-stop must report the resulting pipe-close exit truthfully, without a stale survival claim.

## Verification

On 2026-09-13 at 20:11 local time, `swift test --package-path macos --build-system native` passed **294 tests, with 4 live opt-in tests skipped and zero failures**. The first full run had one outdated assertion that treated ChatGPT as CSS-only; it was updated to recognize a live recoverable JS failure in the newly configured exact profile. All production Swift and the revised opt-in Figma test compiled.

Added coverage checks all 47 explicit declarations and target bindings, legacy absence, malformed metadata, forbidden flags, retained Figma/VS Code boundaries, exact ChatGPT ID and source limits, missing/foreign helper target markers, and preservation of existing helper/configuration/session artifacts when disabling the final record. These unit checks do not establish that each vendor page currently accepts the runtime or that user interactions work in all those apps.
