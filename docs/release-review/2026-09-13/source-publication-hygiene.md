# Source publication preparation — 13 September 2026

This is a bounded source/doc inspection for the authorized public repository, not another release review or a live app test. Candidate 12 was superseded after its Claude rapid-toggle failure. Claude’s corrected 25-check live proof passed on candidate 0.1.12/build 13. Figma startup-readiness investigation then deferred publication to **0.1.14/build 15**, whose final Figma packaged trial passed 22 checks and whose notarization, stapling and Gatekeeper checks have completed. This record documents the preparation checkpoint before the root task’s source/release publication step. No Git index, release, runtime, installed app or private signing storage was changed by this inspection.

## Inspected scope and findings

The scan covered the explicit project source directories, root package metadata, native build configuration and Markdown documentation. It excluded generated `output`, `dist`, `node_modules`, `.build`, `.swiftpm`, `.git`, all unrelated `domain-typo-generator` contents and non-Markdown diagnostic artifacts in `docs`. No private signing files were read.

- No literal private key block, provider token, JWT or non-placeholder credential assignment was found in the 269 text files at the first checkpoint. This is a bounded pattern scan and manual inspection, not proof that arbitrary data can never contain sensitive content.
- A final rescan covered 273 text files after the documentation/source additions and found zero sensitive-pattern or personal-home matches. The updated documentation passed 191 local file/heading-link checks. README npm commands were checked against the actual package script entries; no app or build was run for this check.
- Two personal checkout paths in `manager-update-higher-assets.md:5` and `:8` were replaced with repository-relative paths. The stale unexecuted-preparation wording was corrected to link the completed update result.
- URL-userinfo/email-shaped matches in `macos/Tests/UpdateConfigurationTests.swift:23`, `tests/catalog-extensions.test.mjs:149`, `:153`, `:175`, `tests/catalog-stylesheet.test.mjs:66`, `tests/install-catalog-app.test.mjs:21`, `tests/owned-local-service.test.mjs:48` and `tests/update-settings.test.mjs:14` are deliberately invalid test fixtures, not user credentials.
- The updater public key, application/team identifiers and Keychain account name are public configuration. The corresponding private key is not in the staged source plan.
- The source directories contained 201 files and no symlinks at inspection. The one Python file is the owned Sparkle test-harness builder, not a generated binary. Avoid broad staging of `docs`: it also contains PNGs, raw logs and verification JSON retained only as local evidence.

Runtime packaging copies `ws` including its license (`scripts/lib/package-runtime.mjs:43`), the official Node license (`scripts/lib/bundled-node.mjs:47`, `scripts/lib/package-runtime.mjs:51`) and Sparkle's license (`scripts/lib/update-settings.mjs:67`). The README's npm commands resolve to the existing package scripts and source files. Packaged users do not need Homebrew Node; Node/npm remains a source-build requirement.

Current docs now distinguish origin configuration from evidence: Slack, Notion and Figma accept paths on their exact HTTPS origins, while Figma's full live proof covers login only. Claude's fixed main-process bridge uses its manually enabled inspector; imported source executes in the selected isolated renderer. Claude’s complete 25-check new-chat lifecycle proof has now passed with build 13. The new [setup guide](../../CLAUDE-SETUP.md) and [prepared 0.1.14 release notes](release-notes-0.1.14.md) preserve those limits. The Dock guide also replaces its obsolete two-profile/CSS-only/external-Homebrew description with the current packaged runtime, Claude's existing-process exception and opt-in-only screenshot behavior.

## Explicit source staging plan

Run from the repository root only after reviewing the final changes. This command has **not** been executed by this subtask:

```sh
git add -- .gitignore README.md COMPATIBILITY.md HANDOFF.md \
  package.json package-lock.json compatibility controller examples \
  extensions fixture lib scripts styles tests \
  macos/Package.swift macos/Package.resolved macos/Info.plist \
  macos/Node.entitlements macos/UpdateConfiguration.json macos/README.md \
  macos/CatalogLaunch macos/Launcher macos/ProcessIdentity \
  macos/Shared macos/Sources macos/Tests ':(glob)docs/**/*.md'
git diff --cached --stat
git diff --cached --check
```

Keep diagnostic screenshots, raw logs, verification JSON, release archives, session records and user-state snapshots out of the public source commit. Local `output/` links in published docs identify retained development evidence; they do not imply that those private artifacts ship with the source.

## Production asset parameters

The final release identity is **0.1.14 / build 15**, tag **`v0.1.14`**. The frozen app is confirmed as 0.1.14/build 15, Apple Accepted (`6030c18d-2bf5-4b9a-8d80-d4cb3c430ced`), stapled and Gatekeeper accepted; the final Figma trial passed 22 checks in 78.076 seconds. These completed checks support the following production preparation plan. The earlier build-13 production assets were prepared and signature-verified but remain unpublished; keep their receipt and archive unchanged.

The root task prepared the frozen accepted build-15 artifact with the production command below. Both archive and feed signatures verify, with normal Gatekeeper enforcement. The archive SHA-256 is `2f8075caf9f9c4efb0768cd3fd420e066f7ee690a1aa6aab3fef6a0ffe547906`. This records the completed preparation; do not rerun it into the existing directory:

```sh
npm run prepare:update -- \
  --app 'output/release-review/2026-09-13/notarization/build-15/Extensions Anywhere.app' \
  --output 'output/releases/0.1.14-build15'
```

Use the actual confirmed frozen path if it differs. Do not use `--development-test`. The expected public assets are `Extensions-Anywhere-0.1.14-15.zip` and `appcast.xml`; the generated enclosure prefix is `https://github.com/b-nnett/electron-extensions/releases/download/v0.1.14/`. The normal feed remains `https://github.com/b-nnett/electron-extensions/releases/latest/download/appcast.xml`. Review the generated version/build, archive hash and both signatures before upload. An existing preparation directory must not be overwritten or reused.

The root task should first verify that tag/release `v0.1.14` does not already exist. Create a draft with exactly those two assets and the finalized notes, targeting the reviewed published source commit. Replace `REVIEWED_SOURCE_SHA` below with that exact commit, rather than assuming the current default branch contains the app:

```sh
gh release create v0.1.14 --repo b-nnett/electron-extensions \
  --target REVIEWED_SOURCE_SHA --draft \
  --title 'Extensions Anywhere 0.1.14' \
  --notes-file docs/release-review/2026-09-13/release-notes-0.1.14.md \
  output/releases/0.1.14-build15/Extensions-Anywhere-0.1.14-15.zip \
  output/releases/0.1.14-build15/appcast.xml
```

Only the root task's final publication step promotes the reviewed stable release:

```sh
gh release edit v0.1.14 --repo b-nnett/electron-extensions \
  --draft=false --prerelease=false --latest=true
```

Do not overwrite the separate `updater-e2e-20260913` prerelease or upload verification/state records. After publication, anonymously download both exact-tag assets, compare them with the reviewed hashes and signatures, and verify that Latest resolves to the new signed feed. The earlier actual manager 3→11 self-update is the recorded installation proof; preparing the new assets is not a claim that a second live update occurred.
