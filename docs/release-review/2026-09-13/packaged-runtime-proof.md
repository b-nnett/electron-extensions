# Relocated signed-package runtime proof

The coordinating root exercised the owned Style Lab fixture using the runtime from immutable signed candidate builds 2 and 3. Each proof used a newly created library, relocated the signed manager to a temporary directory, ran with `PATH=/usr/bin:/bin` and a working directory outside the checkout, and used the Node/native identity binaries inside that relocated package.

Both records report **passed**: CSS applied, disabling restored the baseline, re-enabling reapplied it, then graceful shutdown removed the stylesheet, verified baseline restoration, closed the listener, removed the temporary profile and exited without forced termination. Fixture hashes and signing remained unchanged. The relocated copy's signature verified and the temporary copy was removed afterwards.

- [Build 2 proof](../../../output/release-review/2026-09-13/packaged-runtime/result-build-2.json)
- [Build 3 proof](../../../output/release-review/2026-09-13/packaged-runtime/build-3/result.json)
- [Build 2/build 3 relevant runtime hash comparison](../../../output/release-review/2026-09-13/packaged-runtime/build-2-vs-build-3-hashes.json)

The proof records include the source bundle, build number, runtime binary/module hashes, actual process identity, computed appearance states and cleanup outcomes. Their fixture screenshots are supervised test evidence; they do not establish screenshot behavior in ordinary catalog/ChatGPT production sessions.

This demonstrates the relocated packaged runtime and the owned fixture's CSS lifecycle on the current Mac. It does not prove all 50 target apps, JS execution, a literal Dock interaction, another machine or minimum-OS installation, Intel/universal support, or a Sparkle update. Those remain separate acceptance gates in the [release readiness index](README.md).
