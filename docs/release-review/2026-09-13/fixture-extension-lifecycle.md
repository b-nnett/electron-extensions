# Owned-fixture JavaScript lifecycle

Implemented 13 September 2026. This is cooperative lifecycle infrastructure for the project-owned Style Lab renderer. It is not a production script injector, a Chrome extension sandbox, or evidence that a third-party app supports JavaScript extensions.

The only implementation files added by this subtask are `lib/fixture-extension-runtime.mjs` and `tests/fixture-extension-runtime.test.mjs`. There are no imports or source evaluation in the core. Production catalog/ChatGPT guards, target launch flags, vendor packages, and CSP remain unchanged. Root owns the separate fixed-example renderer proof and any later integration decision.

## Internal adapter interface

`FixtureExtensionRuntime` accepts `enable({extensionID, revision, files:[{fileName, execute}]})`, `disable(extensionID)`, `dispose()`, `state(extensionID)`, and `logs()`. The `execute(ea, console)` function is provided by the trusted owned-fixture adapter; it is not a manifest field or a public `mount`/module-export contract. Source strings are rejected by the core.

The extension script sees the agreed frozen lexical `ea` object: `ea.id`, `ea.signal`, and `ea.onDispose(fn)`. Its lexical console exposes `log`, `info`, `warn`, and `error`. This does not replace the page's global console. Neither object exposes Node, IPC, filesystem operations, a main-process evaluator, a debugger connection, or a CSP override. The actual absence of Node globals comes from the fixture's sandboxed Electron renderer, not from pretending that a JavaScript context object is a security boundary.

The existing manifest remains version 1, with name/description/version and ordered `css`/`js` relative files. The runtime receives validated, already bound adapter functions. It does not read a manifest, resolve source paths, import files, install CSS, discover a target, or authenticate an extension publisher.

## State and cleanup contract

An extension has its own serialized operation queue and generation. Different extension queues run independently. Re-enabling the same active revision/file list does nothing. A changed revision disposes the old generation before executing the new files in their supplied order. The caller must use an immutable revision tied to source contents; the core cannot compare source bytes it never receives. After a full document reload, the owned host must explicitly create a new runtime and re-enable its selected extensions.

States are `loading`, `active`, `unloading`, `disabled`, and `failed`. State includes revision, generation, file names, `cleanupComplete`, `reloadBlocked`, and an attributed last error. Malformed adapter input rejects. Extension execution failures resolve a `failed` state after cleanup attempts, allowing the host to display failure without confusing it with a successful load.

`ea.onDispose` accepts callbacks while the generation is loading or active and its signal has not been aborted. Registration after that point throws. Register cleanup when acquiring a resource, before any later asynchronous failure can occur. Up to 256 callbacks are accepted per generation. `onDispose` returns no unregister function.

Disable/replacement aborts the signal first, then consumes callbacks exactly once in reverse registration order, including callbacks registered by different source files. Promise-returning callbacks are awaited. The default loading and cleanup deadlines are each 3 seconds; the internal fixture host may configure 5–10000 milliseconds. The cleanup callbacks share one deadline. Once it is exhausted, remaining callbacks are still attempted with minimum one-millisecond timeout races rather than silently skipped.

A load exception followed by successful registered cleanup reports `failed`, `cleanupComplete:true`, and permits a later enable. An unfinished asynchronous initializer, rejecting disposer, or timed-out disposer reports `failed`, `cleanupComplete:false`, and `reloadBlocked:true`. That uncertainty persists across subsequent disable/enable/dispose calls; consuming a failed callback does not repair its resource. A fresh owned document is required to recover from this blocked state.

`cleanupComplete` means the known registered callbacks finished and no timed-out initializer remains outstanding. It is not automatic proof that all DOM changes, listeners, timers, requests, or other effects have been reversed. The fixed button proof separately checks its actual node and detached listener. Extensions must register their own resources and honor the abort signal. No timer can preempt a synchronous infinite loop in the same renderer; an owned renderer's independent supervisor would need to handle a hung process/context. The core neither terminates processes nor claims hostile-code containment.

## Logs and bounds

Each event is `{sequence, extensionID, fileName, revision, level, message, timestamp}`. Sequence starts at 1 and is increasing within one runtime instance. Recreating the runtime in another document starts a new sequence; a future session-wide producer must handle that boundary explicitly. Revisions are normalized to bounded ASCII strings. Timestamps use UTC ISO8601. Cleanup errors keep the file name that registered the callback.

Messages are at most 4096 UTF-8 bytes and stop formatting after that budget. Explicit primitive arguments are rendered; objects/functions are labeled without enumerating properties, invoking `toJSON`, or serializing DOM contents. Logs do not implicitly collect page content or screenshots. Lifecycle errors include a bounded message without a stack. Retained console callbacks from an ended or replaced generation are ignored; cleanup callbacks may log while unloading.

The core retains at most 500 events and reserves a maximum 504 KiB budget, including conservative pretty-print overhead. This leaves space for a 512 KiB native envelope such as `{schema:1, appKey, sessionID, events}`. The external sink must still enforce its own final serialized file bound. `onLog` is optional; synchronous throws and asynchronous rejections from it cannot interrupt loading or cleanup. Sink success is not implied by an extension being active.

There are at most 64 recorded extensions per renderer and 32 files per enable. Old states/logs belong only to that runtime instance. There is no user-data cleanup, shared-process hook, or global-error capture.

## Verification

**17 synthetic tests passed**, included in the final **192-test Node suite**, with zero failures: [final suite log](../../../output/release-review/2026-09-13/full-js-followup-node-final.log). The additional case verifies the same case-insensitive `.js` suffix handling as the importer while preserving the original filename in logs.

```sh
node --test tests/fixture-extension-runtime.test.mjs
```

Checks cover frozen lexical API/log attribution, idempotence, revision replacement, file/disposer ordering, async load and cleanup failures, sticky cleanup uncertainty, cooperative cancellation, independent queues, stale contexts, failing log sinks, object logging without inspection, byte/event/resource limits, and invalid input. They do not launch apps or modify the user's library.

The separate `scripts/testing/verify-fixture-extension-runtime.mjs` ran the exact checked-in mixed CSS/JS example in the existing owned Style Lab page. All nine renderer checks passed after the sticky-failure, log-bound and filename-suffix fixes. The [final report](../../../output/release-review/2026-09-13/fixture-javascript-35b44022-c4c9-4cda-9613-9cc2bf69cd75/report.json) records the exact source hashes and unchanged fixture integrity. This does not establish GUI import, Dock broker loading, automatic document reapplication, or third-party support.
