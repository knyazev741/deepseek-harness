# Agent Note: Fork overlay manifest ownership and verification

Status: implemented

English | [中文](2026-08-22-fork-overlay-manifest.zh.md)

## Problem

Fork differences need durable ownership and bounded comparison against upstream. A Git diff alone does not say whether a path belongs to a fork plugin, composition, extension point, or unavoidable product behavior, and it cannot expose stale declarations or a patch that silently expands to an upstream package. Verification evidence also needs to be inspectable without allowing manifest data to execute arbitrary shell commands.

## Decision

`.fork/overlay.yaml` is a source-plane inventory of the fork difference. It records schema version 1, an immutable 40-hexadecimal upstream SHA in `upstreamCommit` used as the comparison parent, and entries with exact repository-relative path declarations. An `exact` declaration matches one path; a `tree` declaration matches the declared directory and descendants. Paths use no globs, traversal, absolute forms, NUL, or backslashes, and a tree declaration ends with `/`. `agentNote` is a repository-relative file path with the same safety restrictions plus a prohibition on trailing `/`; parsing does not require that file to exist.

The source-ownership classes are `fork-owned`, `composition`, `extension-patch`, and `product-patch`. `workflow` is an additional exact-path manifest kind for fork-owned workflow files, not a fifth source-ownership class. `fork-owned`, `composition`, and `workflow` are fork-side classes, so every path they own must be absent from the upstream tree; a collision also includes an upstream file at the root of a declared tree. Composition entries describe fork assembly around upstream packages; extension patches add a general upstream registration point while the behavior stays in a fork plugin; product patches record narrow upstream behavior changes with explicit budgets. Every diff matched by an extension or product patch must have at least one old or current path present in upstream. Deletions, renames, and copies use the diff record's upstream side as the anchor, so a new destination need not already exist; a pure added diff without an upstream path fails with `upstream-ownership-mismatch`. Patch budgets limit files and changed lines, and each entry records an owner, Agent Note, structured verification targets, and a retirement condition.

Workflow entries use exact paths beneath `.github/workflows/` and are subject to the same fork-side upstream absence check.

Git reads remove every case-insensitive `GIT_*` environment variable before setting only `GIT_OPTIONAL_LOCKS=0`, preserving ordinary process and platform variables. Tree and diff revisions are preceded by `--end-of-options`, with the final `--` retained for path limits.

The classifier requires each changed path to have exactly one owner and fails on overlap or an uncovered path. It checks old and new paths of a rename or copy separately for ownership, but counts the record's Git numstat once in both file and changed-line budgets. It enforces fork-side absence from upstream and upstream anchors for patch diffs. A binary change contributes one changed line, so binary content cannot bypass a budget. It fails on an upstream collision under a fork-side path, an upstream-owned patch without an anchor, an upstream-owned whole-package patch, a stale entry, or a budget overflow; a missing comparison commit and invalid verification target also fail verification.

Verification targets are structured declarations: a non-empty repository `script` name or a list of supported Vitest test files. The verifier checks that the referenced package script or test files exist and satisfy repository-path and file rules; it never executes a declared target. Behavioral evidence remains in the referenced repository checks rather than in manifest parsing.

Activation is deliberately deferred until the migrated tree is completely classified. The real `.fork/overlay.yaml` and the top-level CI aggregate appear together at that cutover; before then, the verifier accepts fixture manifests without requiring the default file.

## Verification

Parser, workflow-prefix, and safe-agent-note behavior are pinned by `scripts/fork-overlay/manifest.spec.ts`. Classification, overlap, stale-entry, fork-side collision, tree-root collision, upstream-anchor, rename/copy, binary, whole-package, and budget behavior are pinned by `scripts/fork-overlay/classify.spec.ts`. Git tree/diff parsing, hostile environment and revision handling, and verification-target existence checks are pinned by `scripts/fork-overlay/git-reader.spec.ts` and `scripts/fork-overlay/verify.spec.ts`, while CLI fixture success and failure behavior is pinned by `scripts/verify-fork-overlay.spec.ts`. The real `.fork/overlay.yaml` and top-level CI aggregate are intentionally absent until cutover, so real-manifest and aggregate-CI coverage is a named gap until the migrated tree is completely classified.

## Alternatives considered

**Mirror branch.** A mirror branch duplicates upstream state and makes branch synchronization another source of truth. The immutable commit in the manifest gives each candidate a direct comparison parent while ordinary Git history remains authoritative.

**Duplicate checked-in patch files.** Separate patch files can drift from the applied tree and create a second code representation. The manifest records ownership, paths, budgets, verification declarations, and retirement conditions while Git remains the code source of truth.

**Wildcard or legacy class.** A wildcard or catch-all ownership class hides new paths and makes overlap and retirement ambiguous. Exact/tree declarations and the closed ownership vocabulary force every changed path into an explicit owner; `workflow` remains limited to exact workflow paths.

**Verification shell commands.** Shell command strings would give repository data execution authority, make verification depend on shell behavior, and permit side effects. Structured script and Vitest declarations are checked for existence and never run by the verifier.

**Activation against the unmigrated legacy diff.** Requiring the real manifest before the migrated tree is classified would encourage a wildcard, temporary class, or oversized budget to conceal existing differences. Activation waits for a complete classification so the default manifest and CI aggregate enforce the intended inventory from their first use.

## Consequences

The fork must classify every difference from the recorded upstream parent, and an upstream collision, patch without an upstream anchor, overlap, uncovered path, stale entry, whole-package patch, invalid target, or budget overflow fails closed. This makes ownership drift visible during ordinary fork changes and upstream syncs.

Patch budgets cannot be bypassed with renames or binary files, while exact/tree coverage keeps the ownership boundary reviewable. The manifest describes classification and verification declarations; it does not replace behavior tests, package checks, or assembled-product evidence.

Target declarations are safe to inspect because the verifier does not execute them. The real manifest and top-level CI requirement remain absent until the migrated tree is completely classified, so current fixture checks do not assert an incomplete legacy inventory.
