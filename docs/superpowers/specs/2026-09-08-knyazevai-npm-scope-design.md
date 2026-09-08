# KnyazevAI npm Scope Design

English | [中文](2026-09-08-knyazevai-npm-scope-design.zh.md)

## Goal

The fork publishes its complete DSH package family under the npm account that owns the release credentials. The installed command is `npx @knyazevai/dsh`; it boots the same `fork-web` product as `pnpm dsh web` from a source checkout and includes the half-window compaction and first-chunk timeout recovery fixes.

The migration changes package identity, not the runtime architecture. Vendored Cordis packages remain under `@deepseek-ai` because they are independently published dependencies whose current names are resolvable from npm.

## Package identity

Every workspace package whose name begins with `@deepseek-ai/dsh` moves to the equivalent `@knyazevai/dsh` name. This includes the private workspace root name, the CLI, bundles, runtime packages, test-support packages, and examples. Package suffixes and the shared DSH version remain unchanged.

References to those package identities move together across package manifests, TypeScript imports and module augmentations, Cordis YAML, tsconfig paths, build configuration, release tooling, tests, snapshots, and current documentation. Repository URLs and the vendored `@deepseek-ai/cordis`, `@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`, and `@deepseek-ai/cordis-plugin-*` names do not change.

Frozen archived Agent Notes retain their recorded historical text. Active Agent Notes that define current package identity are updated or superseded through the normal note lifecycle.

## Migration mechanism

A repository-owned rescope command performs the package-token rewrite deterministically and supports check mode. It operates on tracked, eligible source files, excludes `vendor/`, generated build output, dependency trees, historical decision records under `.agents/notes/`, migration design and plan records, and its own source-prefix declaration, and rewrites only the `@deepseek-ai/dsh` package-name prefix. The active Agent Notes that own npm identity and publication are updated deliberately instead of by the mechanical pass. A second application produces no diff.

Postconditions make omissions fail loudly: DSH release members use `@knyazevai/dsh*`, no eligible runtime, build, test, configuration, or current-reference source contains the old DSH prefix, vendored package names remain unchanged, and the CLI manifest is exactly `@knyazevai/dsh`. Only the migration records and the command's source-prefix declaration may retain the old prefix. Workspace constraints and release-family validation enforce the new identity after migration.

The command stays in the fork so a later upstream sync can reapply the fork's npm identity to newly introduced DSH packages and references instead of relying on a one-time global replacement.

## Release sequence

The DSH family keeps one shared version and the existing `dsh-v<version>` tag format. The first release under the new scope is `0.1.5`; the failed `0.1.3` and `0.1.4` GitHub tags remain historical and no package with either version was written by those failed workflows.

The GitHub release workflow continues to build and pack without registry credentials, verifies installation from the produced tarballs, then publishes those exact bytes through the protected `npm-publish` environment. `NPM_TOKEN` belongs to the `knyazevai` npm account and is never exposed to the pack job.

Publication order remains dependency-first. The release verifier rejects a private member, an old DSH package name, a mismatched shared version, a tag/version mismatch, or an unrepresentable dependency order before building.

## Installed dependency graph

Published manifests refer directly to `@knyazevai/dsh-*` siblings. The design does not use npm aliases, install-time rewriting, postinstall downloads, GitHub tarball dependencies, or a wrapper that delegates to `@deepseek-ai/dsh`.

This keeps the installed graph ordinary: npm resolves every DSH dependency from one owned scope, Node resolves the same package specifiers that the built JavaScript contains, and Cordis loads the package names present in the shipped configuration. Readable vendored dependencies continue to resolve from `@deepseek-ai` without granting the fork publication rights there.

## Verification

The migration is accepted only when all of the following hold:

- a source scan and the rescope check find no stale eligible `@deepseek-ai/dsh` package token;
- package constraints and release verification accept every DSH member under `@knyazevai`;
- the focused compaction, timeout-recovery, and client-bundle tests still pass;
- the keyless low-pressure first-chunk timeout snapshot still compacts and continues;
- the official build emits the complete Host and Web artifacts;
- every DSH and vendored tarball installs together in an empty consumer directory and the packed executable reports `0.1.5`;
- the tagged GitHub workflow publishes successfully; and
- `npm view @knyazevai/dsh version` and a cache-independent `npx @knyazevai/dsh@0.1.5 --version` both report `0.1.5`.

Existing unrelated baseline failures in repository-wide hygiene or documentation checks are reported separately and do not replace any release check listed above.

## Alternatives considered

### Publish only a wrapper CLI

A wrapper would still need the unavailable `@deepseek-ai/dsh-*` versions, or it would have to download and build the GitHub repository during installation. That makes `npx` dependent on another network source, mutable repository state, and install-time execution.

### Rewrite package names only inside tarballs

Artifact-time aliases could leave source imports under the old scope while installing mirrored packages under alias paths. Peer-dependency handling, self-references, Cordis configuration, diagnostics, and future dependency additions would then depend on a second identity graph that ordinary source checks cannot see.

### Obtain access to the `@deepseek-ai` npm organization

Publishing under the original scope would minimize the diff, but it depends on external organization membership that the fork owner does not control. The fork already has an owned npm scope and a working publication token.

## Risks

The mechanical diff is large because package identities occur throughout the workspace. A deterministic codemod, explicit exclusions, idempotence, stale-token checks, and packed-install verification reduce the risk of a partial migration.

Existing consumers of `@deepseek-ai/dsh` do not automatically move to the fork package. This is intentional: the fork command is `npx @knyazevai/dsh`, and no package is published into a namespace the fork does not own.

Future upstream merges may introduce the original DSH prefix. Keeping the rescope command and its check in the fork makes that drift visible before build or publication.
