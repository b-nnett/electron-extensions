# Retention for newly owned launcher sessions

Implemented 13 September 2026 in `macos/Shared/RuntimeSessionRetention.swift`, with minimal creation/termination hooks in `macos/Launcher/LauncherMain.swift`.

Newly created launcher sessions receive a private `.ea-session-owner.json` marker before the broker starts. It records a fixed owner/schema, launcher identifier, session UUID, directory device/inode, creation time, and the launcher's PID/UID/kernel start. Once the owned broker starts, its PID/UID/kernel start is recorded; normal broker termination records a close time. The marker is created exclusively, so an existing session cannot be silently adopted. Marker updates require the original launcher identity and preserve an unchanged marker during atomic replacement.

When a new session starts, maintenance considers older marked sessions in that same launcher's `Sessions` directory. It keeps the **10 newest eligible inactive sessions** and removes eligible sessions beyond that count or older than **14 days**. This is opportunistic launch-time maintenance, not a timer or a promise that files expire while the launcher is never used.

A session is eligible only after both recorded owner processes have positively ended: kernel-confirmed absence or a valid different kernel start at the same PID. A close timestamp alone is insufficient. An active or unreadable process always preserves its session. A process that reused a PID is never signalled or otherwise operated on. The current session is always excluded before candidate inspection.

## Preserved data and bounds

- **Legacy and manual diagnostic sessions remain untouched.** Missing markers, other owners/schemas, mismatched session UUIDs or directory identity, malformed/future-dated metadata, and sessions lacking a confirmed broker identity are preserved. There is no blanket migration that retroactively marks old data.
- A symlinked or substituted root, session, marker, file or subdirectory is rejected. File hardlinks, group/other-writable directories, unexpected files, and unknown subdirectories prevent pruning that session. Allowed payloads are fixed session metadata/log names, fixed revision PNG names, and the known Style Lab evidence directory structure.
- Root enumeration stops at 512 entries **before any deletion**. A session scan stops at 512 nodes, a maximum of three directory levels including the session, 16 MiB per file and 128 MiB of total file sizes. Marker reads are limited to 8 KiB. Oversized or unexpected archives are preserved rather than traversed or removed indiscriminately.
- Directory descriptors, `openat`/`fstatat` with no symlink following, regular-file checks and node identities bind inspection to the selected filesystem objects. After the bounded scan, the owner processes, marker bytes, directory locations and complete file snapshot are checked again before deletion. Each removal uses descriptor-relative `unlinkat` with another location/file check. The marker is removed last; no recursive `FileManager.removeItem` operates on a candidate session.
- Maintenance failures do not block launching the user's app. They leave the affected data for later inspection. Successful pruning never edits target apps, extension records, Dock pins or helper configuration.

These rules bound work and prevent deletion outside positively owned eligible sessions. They do **not** promise a total disk cap when legacy, active, malformed, oversized or otherwise uncertain sessions accumulate. In particular, an archive with over 512 root entries needs explicit user-directed cleanup rather than an unbounded automatic traversal. An in-flight filesystem failure can leave an eligible session partly removed; the operation stops, retaining its marker when possible. Concurrent mutation by an arbitrary same-user process cannot be made transactional across a directory tree, but known changes are rejected and no symlinks or unknown payload trees are followed.

The catalog broker's fresh-output check now permits the new native marker alongside `launcher.log`, plus the strictly named atomic marker-update temporary file that can briefly coexist while the broker starts. A synthetic test covers that startup race. Existing report/image files still reject reuse of a session directory. Standalone diagnostic CLIs do not write ownership markers and are therefore not automatically pruned.

## Verification

All destructive verification is restricted to newly generated temporary test directories. **No cleanup command was executed against this user's real session directories or existing diagnostic files.** No third-party app was launched, restarted, attached to, or modified.

The source and 12 new XCTest cases pass Swift parsing. The coordinating root is running the combined Swift build/test suite; its result is authoritative for compilation and XCTest execution. The cases cover:

1. Marker identity/permissions and refusal to adopt nonempty directories.
2. Keeping the newest 10 and always excluding current sessions.
3. The 14-day age condition.
4. Active, unknown, missing and recycled broker identities.
5. Unknown/running launchers despite closed markers.
6. Legacy, malformed, copied and oversized markers.
7. Unexpected files/directories, symlinks and hardlinks.
8. The bounded known Style Lab evidence layout.
9. Session replacement during process revalidation.
10. File mutation during process revalidation.
11. A root scan limit that prevents any deletion.
12. A symlinked Sessions root.

**18 affected Node tests passed with zero failures** (`tests/dock-catalog-session.test.mjs`, `tests/runtime-diagnostics.test.mjs`). [Saved output](session-retention-node-tests.log). This source change will affect only new sessions after the updated helper is installed and launched normally; it does not retroactively change the retention status of historical evidence.
