# Normal runtime screenshot privacy fix

Implemented 13 September 2026. This closes the unsolicited screenshot collection finding in [security review 3](03-extension-security.md) at source level. Rebuilding the manager and refreshing its inactive generated helpers are necessary to distribute the change; already-running helpers retain their existing runtime until their normal exit. This work did not interrupt them.

## Changed behavior

Normal catalog and ChatGPT extension sessions now collect **no renderer screenshots**. This covers first application, changed CSS, disabling, restoration, and the formerly discarded paint-priming capture. Extension names—including `Hide Sidebar Voice Button` and the E2E extension name—never grant screenshot consent. Normal reports explicitly record `screenshotsEnabled: false`, zero captures/bytes, screenshot scope `none`, and null screenshot filenames.

The CSS paths still validate process/renderer ownership, read back stylesheet text, observe computed CSS metadata, compare the target's bundle/signature, and remove the owned stylesheet. The privacy change adds no launch flags to target apps, no JavaScript execution, and no new attachment capabilities.

All captures go through `lib/runtime-diagnostics.mjs`. Its default is disabled, and disabled capture requests return before invoking renderer code or creating files. A second check at the transport boundary rejects any accidental `Page.captureScreenshot` call during normal operation. Catalog and ChatGPT brokers both use this boundary. The UI and generated launcher do not supply a diagnostic opt-in.

## Explicit diagnostics

The standalone catalog and ChatGPT broker CLIs accept the optional **`--diagnostic-screenshots`** flag for a deliberately supervised test. Programmatic calls must supply the literal boolean `diagnosticScreenshots: true`; strings, environment variables, extension manifests, and record names do not enable it. Repeated CLI flags are rejected.

The flag prints a notice that the **complete visible renderer may contain private app content** and will be saved in the chosen fresh session directory. This is a full renderer viewport, not just a selected button, and excludes native window chrome. Reports repeat that scope. No diagnostic command was run against an installed target during this change.

Diagnostic collection is bounded to at most **64 capture attempts and 64 MiB of accepted PNG data per session**, with at most **8 MiB per image** and 16 megapixels. Paint-priming images count toward the same budget even though discarded. Capacity is reserved before collection, including concurrent requests; collection stops before starting a capture that lacks capacity. Each image is created with mode 0600 and exclusive creation, preventing replacement of existing images or following an existing destination symlink. Only fixed revision/phase filenames are permitted. Exhaustion or invalid evidence fails the explicit diagnostic session instead of claiming a complete visual proof.

The old native E2E harnesses expect automatically recorded session PNGs. Their existing required-image checks intentionally remain strict: normal production sessions no longer satisfy those checks. A future supervised native diagnostic integration must explicitly request/capture its evidence; no extension-name or global-environment workaround was added to silently restore collection. Existing diagnostic CSS/image tests opt in explicitly.

## Retention boundary

Normal sessions retain metadata, not screenshots. Explicit diagnostic image retention is bounded **within each new session** by the budgets above. A subsequent [ownership-marker retention change](session-retention.md) keeps the newest 10 eligible inactive native-launcher sessions and expires eligible sessions after 14 days. Historical and standalone diagnostic sessions have no ownership marker and remain untouched; there is no blanket migration. Existing files were preserved. This does not claim to cap aggregate storage across active, legacy or uncertain sessions, or an unlimited number of explicit diagnostic invocations.

## Verification

**68 tests passed, 0 failed, 0 skipped.** [Saved output](privacy-fix-tests.log).

```sh
node --test tests/runtime-diagnostics.test.mjs tests/catalog-stylesheet.test.mjs tests/dock-catalog-session.test.mjs tests/chatgpt-stylesheet.test.mjs tests/dock-library.test.mjs tests/package-runtime.test.mjs tests/catalog-native-e2e.test.mjs tests/chatgpt-native-e2e.test.mjs
```

New behavioral checks exercise the actual catalog observation and ChatGPT diagnostic functions with renderer methods that fail if called in ordinary operation. They assert zero calls and empty output directories for the normal before/styled/restored and before/after paths. Other checks verify disabled transport rejection, explicit viewport capture, private file permissions, count/byte limits, concurrent budget reservation, invalid image/path rejection, and preservation of existing files/symlinks.

Existing tests continue to cover CSS readback, navigation, original-control settling, explicit paint priming, cleanup, library selection, packaged dependency copying and native E2E evidence assertions. No production app was launched, attached to, restarted, or changed; no user library or existing session was modified. Live verification of the rebuilt production package is not claimed by these synthetic tests.

## Files

- `scripts/dock-catalog-session.mjs`
- `scripts/dock-chatgpt-session.mjs`
- `lib/runtime-diagnostics.mjs`
- `tests/runtime-diagnostics.test.mjs`
- `tests/catalog-stylesheet.test.mjs`

The TCP-debugger lifecycle and unbounded manager-library findings from the original security review are independent and are not resolved by this change.
