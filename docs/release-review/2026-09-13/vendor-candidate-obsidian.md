# Next vendor candidate: Obsidian

Follow-up: the coordinating task retained the launch-flag architecture and declined the vault-plugin adapter route below. The implementation candidate is now [VS Code through its existing curated renderer broker](vscode-imported-broker.md). This read-only assessment is preserved as background, not a plan to install a plugin.

**Concrete candidate: `/Applications/Obsidian.app`, version/build 1.13.7, bundle ID `md.obsidian`.** Read-only `codesign --verify --deep --strict` passed on 2026-09-13. [Recorded metadata and signature result](../../../output/release-review/2026-09-13/vendor-candidate-obsidian.json) identify this installation. No app launch, debugger attachment, vault access or plugin installation was performed for this assessment.

## Official interface

Obsidian's documented plugin route supports JavaScript loaded from a vault's `.obsidian/plugins/<plugin-id>/main.js`, with `manifest.json` alongside it. Its official sample explicitly describes manual installation of those files plus `styles.css` into the vault, outside the signed application bundle. The sample demonstrates click handlers and console output. [Official sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin)

The developer guide documents loading plugins through Community plugins, adding a ribbon button through `onload()`, and reloading an updated plugin by disabling/re-enabling it. This provides a supported place to mount a JavaScript-driven button and test cleanup. [Build a plugin](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin)

The official UI guide documents `HTMLElement` creation and a `styles.css` file in the plugin root for custom styling. This establishes both JavaScript UI behavior and CSS under the vendor's extension interface. [HTML elements and CSS](https://docs.obsidian.md/Plugins/User%20interface/HTML%20elements)

**Inference:** an Extensions Anywhere adapter could write only its explicitly owned files in a user-selected development vault and leave every file in `Obsidian.app` untouched. That should preserve the app signature; the actual combined-package install/apply/disable proof has not been run. This would use the official plugin interface, not claim that arbitrary CDP evaluation is an officially supported Obsidian extension API.

## Existing project coverage

`docs/INJECTION-GUIDE.md:12` records Obsidian 1.13.7 passing a TCP-CDP CSS trial on the Quick start screen, with the selector `.quick-start-container > button.mod-cta`. Its table explicitly leaves production JavaScript unverified. `scripts/compatibility-session.mjs:17` includes the fixed Obsidian app in the supervised CSS harness; that harness handles CSS trials and ownership checks, not imported packages or a vault plugin adapter. A historical CSS pass is not a JavaScript compatibility result.

## Required integration work

1. Add explicit vault selection and an owned plugin-directory receipt. The current library selects an application identity, while Obsidian plugins are vault-scoped. Use a new dedicated test vault; do not discover or write arbitrary existing vaults silently.
2. Translate an imported package into a deterministic native plugin wrapper. Preserve each authored JS file's body, but bind the current `ea` lifecycle and attributed console through a wrapper. Emit combined `styles.css`, a vendor manifest and the plugin entrypoint. Arbitrary `main.js` text from our present manifest is not already an Obsidian plugin.
3. Map enable/disable/revision changes to the documented plugin lifecycle. Track asynchronous cleanup failures and remove only owned CSS/DOM resources. Existing Style Lab CDP isolated-world bootstrap and its controller cannot simply be pointed at Obsidian.
4. Add an explicit first-run activation flow. Obsidian starts with Restricted mode and requires Community plugins to be enabled. Plugins inherit Obsidian's access; this route must not be presented as a sandbox or silently turn on a user's plugins. [Plugin security and activation](https://obsidian.md/help/plugin-security)
5. Bridge attributed logs and status to the native manager using a bounded, authenticated local channel or an explicitly owned vault file. Reuse the native log schema, not the application's global console. The selected vault, plugin instance and process/session identity must match before presenting “Connected.”
6. Prove the complete flow in the owned test vault: native package import → plugin activation → CSS appearance and JS button handler → attributed log → reload → disable/removal → baseline restoration → unchanged strict signature and bundle fingerprint. Also prove existing unrelated vault files/plugins stay untouched. No such live proof is claimed here.

This is a strong candidate for a supported vendor integration with unchanged signing. It does not solve zero-setup generic injection in every Electron app, and its vault-level adapter is a separate product path from launch-flag debugging.
