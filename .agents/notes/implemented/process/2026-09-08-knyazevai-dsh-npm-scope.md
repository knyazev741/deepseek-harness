# Agent Note: Permanent DSH npm scope

Status: implemented

English | [中文](2026-09-08-knyazevai-dsh-npm-scope.zh.md)

## Problem

The repository is a fork that ships the DeepSeek Harness package family, while its vendored Cordis framework must retain the upstream organization's npm identities. A single `@deepseek-ai` package-prefix rule cannot distinguish the fork's packages from the vendored packages it installs as peers, and an artifact-only rename would leave source imports, workspace links, lockfile entries, and release metadata describing a different package graph.

## Decision

All repository-owned DSH packages publish under `@knyazevai/dsh*`. The private workspace root is `@knyazevai/dsh-root`, and the CLI entry package is `@knyazevai/dsh`; package suffixes, versions, exports, and repository URLs remain unchanged. The nine vendored Cordis packages keep their `@deepseek-ai/cordis`, `@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`, and `@deepseek-ai/cordis-plugin-*` identities. The native Landlock family keeps its separate `@deepseek-ai/node-addon-*` names.

The dsh release family validates `@knyazevai/dsh` names and installs `@knyazevai/dsh` as its entry; the vendor family validates `@deepseek-ai/` names independently. Baseline publication and workspace constraints accept this explicit union, and the hygiene gate runs `rescope-dsh:check` so a stale harness token fails before release. The npm workspace-resolution exception remains owned by [npm CLI resolution](2026-09-03-npm-cli-resolution.md), while the three-sequence publication model remains owned by [npm release sequences](2026-08-10-npm-release-sequences.md).

The repository-owned `rescope-dsh` command is the replay mechanism after an upstream or repository sync. It rewrites the tracked current-state package tokens once, excludes vendored source, generated build output, migration records, and Agent Notes, and supports a check mode that proves no eligible old DSH token remains. Regenerated lockfile and catalogs are committed after the source rename; vendored package content and `github.com/deepseek-ai` repository URLs remain untouched.

## Alternatives considered

**Publish DSH under `@deepseek-ai` beside the vendored packages.** Rejected because the fork does not own that namespace and because one broad scope check would allow a DSH package to impersonate a vendored identity.

**Rewrite names only while packing or publishing.** Rejected because source imports, workspace manifests, lockfile resolution, generated catalogs, and installed-artifact checks would describe another graph, leaving checkout execution and published execution with different identities.

**Publish aliases or compatibility wrappers under the old DSH names.** Rejected because the fork must not publish into a namespace it does not own, and aliases would preserve an unavailable or misleading dependency path instead of making the package graph directly installable.

## Consequences

The package graph has one permanent fork-owned DSH scope and one preserved vendored scope. A clean checkout, a packed install, and npm publication use the same package identities; old `@deepseek-ai/dsh*` consumers do not silently redirect.

Upstream synchronization must replay `pnpm run rescope-dsh -- --apply` after copying eligible current-state changes, then run `pnpm run rescope-dsh:check`, regenerate stale catalogs, refresh the lockfile, and confirm affected bilingual pairs. Historical Agent Notes and migration records remain evidence of earlier decisions and are not rewritten.
