# Claude setup

The current source implements an assisted CSS and JavaScript connection to Claude Desktop at `/Applications/Claude.app`, on the exact **new-chat page** `https://claude.ai/new`. It uses Claude’s own Developer menu. It does not alter Claude’s bundle, signature, entitlements, fuses or private preferences.

**Verified on Claude 1.52386.6 with manager 0.1.12/build 13:** 25 native product checks passed, including visible green buttons, real JavaScript clicks/logs, rapid re-enable, replacement, native reload and cleanup with unchanged target signing. [Complete proof and earlier attempts](release-review/2026-09-13/native-claude-product-proof.md). The [September 6 CSS trials](CLAUDE-DEVELOPER-MODE.md) remain separate historical evidence.

## Connect

1. Add a manifest for Claude in Extensions Anywhere, enable it and choose **Open App**. The launcher uses an existing verified Claude process or opens Claude normally; it does not restart a running Claude simply to attach.
2. In Claude, choose **Help → Troubleshooting → Enable Developer Mode**, if it is not already enabled.
3. Choose **Developer → Enable Main Process Debugger**. This step is required again after each Claude launch. Review any native prompt Claude presents.
4. Open Claude’s new-chat page. Close that window’s DevTools if they are attached. Extensions Anywhere waits for the exact page and an available renderer debugger, then connects automatically.
5. Check the connection status and the extension’s **Runtime** logs in Details. `Waiting for debugger` and `Waiting for page` mean setup is incomplete; a saved enabled toggle does not mean the script is running.

The profile rejects another installation, multiple Claude processes, another owner of the local debugger, an ambiguous matching page or an existing renderer-debugger attachment. It never replaces another debugger connection. Conversation pages, projects, other windows and app versions outside the recorded evidence are not promised by this route.

## What remains enabled

Developer Mode is a persistent setting controlled by Claude. The main-process debugger is a separate per-launch local listener. Extensions Anywhere does not enable either setting automatically.

The main debugger gives local software access to Claude’s full process. Extensions Anywhere runs a fixed bridge there to relay bounded commands to its selected renderer; imported scripts run in an isolated renderer context with the [extension lifecycle API](EXTENSION-FORMAT.md#javascript-lifecycle). This is not a permission sandbox for untrusted extensions, and it does not make the debugger a CSS-only boundary.

Disabling an extension runs its registered cleanup and removes its stylesheet. Ending the extension session detaches its owned renderer debugger and disconnects its inspector client; it does **not** close Claude’s user-enabled main debugger. Use Claude’s normal **Quit** command to close the process and its listener. Arbitrary script side effects cannot be automatically rolled back.

The installed version and exact renderer determine compatibility. Use the [current coverage table](CURRENT-COVERAGE.md) for completed proofs rather than treating successful setup alone as a pass.
