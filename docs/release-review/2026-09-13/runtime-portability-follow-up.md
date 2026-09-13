# Independent bundled runtime follow-up

Date: 2026-09-13. Reviewer: `release_05_ux`, reassigned by the root agent after the UX fixes. Scope: new Node packaging, native helper resource resolution and signing/relocation correctness. No target app, user library or Dock interactions.

## Outcome

The new bundled Node path removes the inspected launcher dependency on a build-host/Homebrew Node installation. Native signing happens before package copying, and runtime resolution uses fixed names under the generated helper's Resources directory. The review found an active-legacy-helper migration regression, now corrected as described below. This is a code/build-artifact review, not an Intel or clean-machine E2E claim.

## Verified evidence

- `scripts/lib/bundled-node.mjs` pins Node 24.21.0 separately for arm64 and x64, checks downloaded bytes before extraction, and rechecks cached archive bytes. Both checked-in SHA-256 values were independently compared with [the official Node checksums](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt), fetched over HTTPS during this review; they match.
- The checked arm64 distribution reports Mach-O minimum macOS 13.5 and SDK 15.0. This is compatible with the app's declared 14.0 floor; it does not by itself prove every runtime behavior on macOS 14.
- `otool -L` on that distribution lists only CoreFoundation, Security, `/usr/lib/libc++.1.dylib` and `/usr/lib/libSystem.B.dylib`. The packaging audit rejects Homebrew, external or `@rpath` dependencies.
- `scripts/build-macos.mjs` signs native helper products first, signs its staged Node copy with the dedicated allow-JIT entitlement, then packages those signed bytes. The helper source hash incorporates the resulting runtime digest. Sparkle and the outer manager are signed afterwards and the result undergoes deep/strict verification.
- `LaunchEnvironment.json` now names `Runtime/native/node`, and `LauncherMain.swift` resolves its own packaged Node rather than using an old absolute `nodePath` from adjacent configuration. The retained configuration field permits existing configurations to migrate without reintroducing the external executable path as the execution source.
- `RuntimeResourceFiles.nativeExecutable` limits names to Node and the two native helper products, requires a nonempty regular file with executable mode bits, caps size, and rejects noncanonical/symlinked paths through the existing metadata validator. It is a path/type check; outer helper-signature and runtime validation supply the separate integrity checks.
- `packageRuntime` carries the Node licence, copies executable mode bits, and stages the dependency closure before replacing a previous complete Runtime directory.

## Active legacy helper correction

Before this correction, `ElectronLauncher.prepare` deliberately deferred replacing an active helper, but still attempted to resolve `Runtime/native/node` from the old helper while rewriting its configuration. A helper from before Node bundling does not contain that file, so Open App/Add to Dock could fail during an otherwise healthy active session.

`ActiveLauncherPreparation.swift` now validates and preserves the existing configuration/alias when preparation was deferred or the helper is active. `ElectronLauncher` invokes it after checking the installed helper signature and fixed broker path, before requiring new bundled Node or rewriting configuration. Target bundle, profile, library, broker, session directory and alias destination must all match. A malformed or changed configuration/alias is refused with a preserved-session explanation. Activity is checked again after replacement work, and an earlier active/deferred observation is retained so a subsequent exit does not create the same migration failure.

The preserved path performs no writes and does not execute the legacy Node. Existing stopped-helper migration continues through the normal transactional replacement. This correction does not relax target identity checks or change third-party signing.

## Tests

Ran:

```sh
node --test tests/bundled-node.test.mjs tests/package-runtime.test.mjs
```

**7 passed, zero failed.** Log: `runtime-packaging-review-tests.log`. The new test preserves native executable bytes/modes and the Node licence after the checkout is moved away and packaged Runtime is relocated. Existing tests cover archive rejection, dynamic-library rejection, staged rollback and actual broker module imports without starting a session.

Added nine focused Swift tests; **all nine passed** in the root agent's [20-test focused final runtime suite](../../../output/release-review/2026-09-13/final-runtime-tests.log), with zero failures (no competing Swift build was started by this reviewer):

- Five `ActiveLauncherPreparationTests`: preserving legacy configuration/alias with no bundled Node; deferred replacement after helper exit; continuing normal migration when stopped; rejecting changed target/profile/library/broker/session configuration; rejecting changed alias/unresolved activity.
- Four new `RuntimeResourceFilesTests`: fixed-name allowlist and relocation; nonexecutable/empty/directory/FIFO rejection; leaf and parent symlink rejection; oversized-file and non-file URL rejection.

The root agent's [final combined native suite](../../../output/release-review/2026-09-13/final-native-tests.log) also passed: 226 tests executed, one skipped, zero failures. Builds 2 and 3 received Developer ID signing and Apple notarization acceptance. The [packaged-runtime proof](packaged-runtime-proof.md) records actual relocated signed-build execution against the owned fixture. Actual Sparkle installation/relaunch remains in progress and is not claimed as passed.

## Remaining scope and limits

The build uses the host Node/Swift architecture. This review inspected arm64, not an x64 or universal output; distribution must state the appropriate architecture. Apple notarization acceptance is now recorded separately by the root agent. End-to-end Sparkle installation and first launch on another Mac remain release gates. No build scripts were changed by this reviewer.
