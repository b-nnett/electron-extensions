# Hide Sidebar Voice Button

Import `manifest.json` into Extensions Anywhere for ChatGPT.

The selector is based on ChatGPT 26.901.31953 (build 7868), inspected read-only at
`/Applications/ChatGPT.app/Contents/Resources/app.asar` →
`webview/assets/app-primary-37ff25fd4643.js`, component `Crr`.
The visible label is **Voice**, but the button's English accessible label is
**Start new voice chat**. Its footer contains the `h-toolbar` class. The previous
extension looked for the wrong accessible label and assumed named sidebar
containers that this component does not declare.

The selector was rechecked against ChatGPT 26.901.51231 before the live trial.
This version targets English UI. Its selector needs rechecking after app updates
or a language change.

## Execution status

The native manager now has an **experimental CSS adapter** for exactly
`/Applications/ChatGPT.app` (`com.openai.codex`). Its runtime shortcut uses our
helper and ordinary Electron renderer debugging. It accepts at most 64 KiB of
enabled CSS and rejects JavaScript. It reports an active session only after
stylesheet readback and this named extension's Voice-hidden check succeed.
The [live cold-start trial](../../output/chatgpt-adapter/live-restart-result.json)
passed on ChatGPT 26.901.51231: after the original app quit normally, the helper
launched a new original-app process. Voice changed from `display: flex` to `none`,
with verified stylesheet readback and unchanged signature/fingerprint. The report
identifies the session containing real before/after footer screenshots.

If ChatGPT is already running, the shortcut activates it and asks you to quit
normally and reopen; it never forces a quit. Broker cleanup removes its own
stylesheet when connected and leaves ChatGPT running. No target bundle,
signing, or protection changes are part of this adapter.

The [owned-renderer check](../../output/chatgpt-adapter/owned-renderer-result.json)
passed hiding Voice, preserving composer/help, disabling, reload/reapplication,
and removal with reconstructed source-backed markup. In the same live ChatGPT
process, [disabling](../../output/chatgpt-adapter/live-disabled.json) restored Voice
to `display: flex`, and [re-enabling](../../output/chatgpt-adapter/live-reenabled.json)
hid it again with `display: none`; signatures remained unchanged. Live reload
remains unverified: its optional check refused multiple packaged-app targets
before requesting a reload. The [managed pin migration](../../output/chatgpt-adapter/installed-launcher.json)
preserved its GUID, position, and unrelated pins, with matching helper/receipt
metadata [after Dock restarted](../../output/chatgpt-adapter/dock-receipt-check.json).
See the [Dock launch guide](../../docs/DOCK-LAUNCHING.md) for the experimental
profile and the separate historical ordinary-alias evidence.
