# Plugin-First Fork Overlay Design

English | [中文](2026-08-22-plugin-first-fork-overlay-design.zh.md)

## Goal

The fork keeps `master` as its deployable product branch while regularly consuming `upstream/master`. Fork features live in independent plugins and bundles whenever the existing extension system can express them. The remaining modifications to upstream-owned files form a small, declared, tested overlay that an agent can adapt or retire during each upstream merge without silently preserving obsolete code.

This project migrates the existing fork to that model and replaces conflict resolution that automatically prefers the fork. Reintroducing the Codex interactive-session integration is a separate follow-on project that must use the extension points established here.

## Branch and repository model

The repository keeps the normal `origin` and `upstream` remotes. `upstream/master` is the authoritative official source after `git fetch upstream`; the design adds no mirror branch.

`master` remains the fork's working and release branch. A scheduled or manually dispatched sync creates `sync/upstream-master` from the current fork `master`, performs a normal merge of `upstream/master`, applies no automatic `ours` or `theirs` conflict preference, validates the resulting fork overlay, and opens or updates a review PR. Only the reviewed candidate can update `master`.

The merge history remains forward-only. Routine sync does not rebase or force-push `master`. The one-time migration may rewrite unpublished migration branches, but the cutover reaches `master` through a reviewed merge.

## Overlay classes

Every difference between `master` and the merged upstream tree belongs to one of four classes.

### Fork-owned packages and files

A fork-owned path does not exist in the upstream tree at the recorded upstream parent. Typical examples are a new provider package, a new UI contribution plugin, a fork composition bundle, a fork-specific workflow, or its tests and documentation. Fork-owned runtime packages still follow the repository package conventions and use the normal Cordis registration lifecycle.

An upstream update that creates any path beneath a declared fork-owned path is an ownership collision. The sync fails until an agent chooses a new location, upstream adoption, or explicit consolidation. The merge never treats the fork directory as automatically authoritative.

### Composition overlays

Fork product assembly lives in new bundle and profile-overlay packages rather than edits to the shipped upstream bundles. A fork Web bundle composes the upstream base and Web bundles, then mounts fork plugins in a documented order. Default upstream bundles remain usable and testable without the fork layer.

Configuration values that vary by deployment remain validated bundle or plugin configuration. The overlay does not hardcode credentials, model routes, paths, timeouts, or policy choices in upstream packages.

### Extension patches

An extension patch changes an upstream-owned file only to add a general registration point such as a Cordis service, event, slot, registry, or contribution interface. It does not contain the fork feature itself. The fork-owned plugin consumes the interface from a separate package.

An extension patch must preserve default upstream behavior when no fork plugin is mounted. Its focused tests prove both the empty/default path and the contributed path. The overlay record names the owning plugin, rationale, verification commands, and the upstream condition that permits retirement.

### Product patches

A product patch is an unavoidable modification to upstream behavior that cannot be expressed through composition or a general extension point. These patches are exceptional, narrow, and separately reviewable. Replacing or freezing an existing upstream package is forbidden; a product patch lists exact files and has an explicit file and changed-line budget.

Each product patch states the observable behavior it preserves, its failure modes, the tests that detect its loss, and when the patch should be upstreamed or removed. Generated artifacts are not independent product patches: the owning source change and generator command account for them.

## Overlay manifest

The repository adds `.fork/overlay.yaml` as a machine-readable inventory. It records a schema version, the exact immutable upstream commit currently integrated into `master`, fork-owned paths, composition overlays, extension patches, product patches, and fork-owned workflow paths. Each entry has a stable id, exact path coverage, an owning package or workflow, a link to the owning Agent Note, verification commands, and a retirement condition. Patch entries also carry file and changed-line budgets relative to the recorded upstream commit.

The manifest describes ownership and verification; Git remains the source of truth for code. The repository does not maintain duplicate `.patch` files whose content can drift from the applied tree.

A source-plane gate compares the candidate tree with the manifest's recorded upstream commit. During a sync, the candidate records the incoming `upstream/master` commit after the source merge succeeds and before overlay validation. The gate enforces these rules:

- every fork-only or modified path is covered by exactly one manifest entry;
- no declared fork-owned path exists in the upstream tree;
- no upstream-owned package is replaced, deleted, or claimed wholesale;
- a patch stays within its declared file and line budgets;
- generated outputs are covered through their owning source entry;
- every verification command resolves to a repository script or exact test target;
- stale manifest entries fail after their diff disappears, forcing explicit retirement;
- workflow exclusions are exact paths rather than the complete `.github/workflows` directory.

The gate runs on ordinary fork changes as well as sync PRs. A new modification to an upstream-owned file therefore cannot enter `master` without being classified.

## Plugin-first product structure

Existing fork behavior is migrated feature by feature. Each feature first receives a behavior inventory and runnable acceptance evidence. The migration then chooses, in order: an existing upstream plugin interface; a fork-owned plugin plus composition overlay; a minimal general extension patch plus plugin; or, only when the preceding options cannot preserve the behavior, a product patch.

The client starts from the complete current upstream client. Fork UI behavior is reintroduced through client plugins, slots, stores, render contributions, and fork bundle composition. Legacy fork client files are not copied wholesale over the upstream client. A missing UI insertion point results in one generic extension patch with an empty-path test, not a forked `InputBar`, conversation shell, theme, runtime, or package.

Host capabilities follow the Service Definition, Service Provider, and Consumer package roles already required by the repository. Features such as external sessions, workspace pinning, model routing, or timeout policy remain separate capabilities or consumers when their behavior is still required. Obsolete behavior is retired rather than automatically carried into the new baseline.

## Upstream sync lifecycle

The sync workflow performs the following lifecycle:

1. Fetch the current `upstream/master` and create or reset the candidate branch from fork `master`.
2. Run `git merge --no-commit --no-ff upstream/master` without a strategy preference.
3. If Git reports conflicts, preserve the conflicted candidate and invoke the configured merge-resolution agent. If no resolver is available or the resolver fails, publish diagnostics and leave the PR unmergeable.
4. Give the resolver the upstream commits, conflicted files, relevant overlay entries, owning Agent Notes, affected package contracts, and exact verification commands.
5. Require the resolver to classify every affected overlay entry as preserved, adapted, upstreamed, or retired. It must understand the upstream change before choosing a resolution and may not select an entire side for an upstream-owned package.
6. Regenerate the lockfile and generated catalogs only after source conflicts are resolved.
7. Run overlay validation, affected focused tests, source-plane typechecks, built-package checks, and the assembled Web proof.
8. Run an independent review agent over the upstream change, overlay decisions, complete diff, and verification evidence.
9. Update the sync PR. Required checks and a safe review verdict permit the normal merge into `master`; failure leaves the PR open without deployment.

The resolver writes only the candidate branch. It cannot push directly to `master`, alter branch protection, suppress checks, or deploy.

## Conflict-resolution agent contract

The merge-resolution prompt is generated from repository data rather than maintained as free-form workflow prose. For each conflict it identifies the upstream intent, the fork behavior at risk, the manifest owner, and the test that observes the behavior. The agent may change the owning plugin and its extension patch together when upstream interfaces evolve.

The agent report contains one record per affected overlay entry: disposition, files changed, behavior retained or intentionally retired, tests run, and residual risk. A separate reviewer rejects unexplained whole-file selections, new unregistered upstream diffs, weakened tests, stale documentation, or a resolution based only on compilation.

Implementation agents for the migration use `gpt-5.6-luna` with maximum reasoning effort. The controller owns the spec, implementation plan, task boundaries, reviews, integration checks, and final acceptance. Each implementation task has exclusive file ownership, follows red-green TDD, and receives fresh review before integration.

## Verification model

The overlay gate proves classification, not behavior. Behavioral acceptance uses layered evidence.

### Source and package evidence

Each manifest entry names focused tests and affected package typechecks. Capability changes include Service Definition, Provider, Consumer, lifecycle, and failure-path coverage. Generated catalogs and bilingual documentation use their owning repository gates.

### Assembled Web evidence

A clean checkout builds the actual fork Web composition. The proof verifies that the emitted application contains its global CSS, theme contribution, client bootstrap, and expected plugin inventory. A browser smoke opens the built fork URL, creates or opens a session, submits a prompt through the normal input, opens the settings/menu control, and asserts no browser or console error.

The Web proof runs against the default upstream composition and the fork composition. This prevents a fork plugin from changing the upstream default and detects build configurations that pass unit tests while omitting CSS or client modules.

### Sync simulations

Fixtures exercise a conflict-free upstream merge, a content conflict, modify/delete and rename/delete conflicts, an upstream collision with a fork-owned path, an obsolete patch, a patch-budget violation, and a broken assembled UI artifact. The workflow fails closed in every unresolved or unverified case.

## One-time migration

The migration starts from current fork `master` in an isolated worktree and records a recovery tag before changing the candidate. The dirty primary checkout and unrelated untracked files are not used or modified.

The migration merges the latest selected upstream baseline normally, then establishes the complete upstream client as the client baseline. Before removal, current fork behavior is captured as feature-level acceptance evidence. Features are restored one at a time through fork-owned plugins and bundles; any required upstream modification is added to the overlay manifest with its tests in the same task.

The migration does not preserve the reverted Codex implementation. Existing external-session packages are evaluated as ordinary fork capabilities: reusable generic parts may remain after their tests pass against the current upstream architecture, while Codex-specific process, MCP, live-stream, and UI work stays outside this project.

The cutover requires a complete overlay inventory, no unregistered upstream diff, no fork-owned replacement of an upstream package, passing relevant repository gates, passing assembled Web evidence, and a reviewed dry-run sync against a newer synthetic or real upstream commit.

## Codex follow-on constraint

The later Codex project is an opt-in provider and Web bundle built on generic external-session interfaces. It may contribute mode selection, transcript nodes, live external output, approvals, and MCP presentation only through registered extension points. It must not replace the conversation shell, `InputBar`, theme, client runtime, or default Web bundle.

If the upstream client lacks a required generic extension point, the Codex project adds one separately reviewed extension patch with default-path evidence before implementing the Codex plugin. The default upstream and fork compositions remain unchanged when the Codex bundle is absent.

## Rejected alternatives

### Automatically prefer the fork during merge

`-X ours` and package-level fork ownership can combine new upstream callers with old fork implementations without a textual conflict. Compilation and unit tests do not prove that the assembled client contains its styles or compatible runtime modules.

### Rebase a literal patch queue for every sync

A rebased series makes the overlay explicit but rewrites the product branch and requires force-push coordination for every upstream update. The manifest and normal merge preserve the same ownership information without making rewritten history part of routine operation.

### Keep the overlay in another repository

A separate overlay repository maximizes isolation but splits local development, dependency installation, package linking, release evidence, and debugging across repositories. The repository's plugin architecture already provides isolation inside one workspace.

### Preserve the complete legacy client as a fork-owned package set

Owning existing upstream client packages prevents the fork from receiving upstream client architecture and creates broad, non-local incompatibilities. The migration keeps upstream packages upstream-owned and moves behavior to contributions.

## Acceptance criteria

- `master` builds the fork product from the current upstream architecture plus the declared overlay.
- `upstream/master` is consumed directly; no mirror branch is required.
- `upstream-sync` contains no automatic fork-side conflict preference and cannot merge an unresolved candidate.
- Every fork difference from the upstream merge parent is covered exactly once by `.fork/overlay.yaml`.
- No fork-owned path claims or replaces a package that exists upstream.
- The complete upstream client is present, and fork UI behavior is supplied through plugins, bundles, or bounded extension patches.
- A clean assembled Web build loads CSS and the expected plugin graph, and its browser smoke exercises session input and settings without errors.
- Conflict and ownership-collision simulations fail closed and produce actionable agent input.
- A resolution agent can adapt a bounded patch using only repository-owned context, and an independent reviewer can verify its decision and evidence.
- The reverted Codex implementation is absent from the migration result; a later opt-in Codex bundle can be added without changing default UI behavior.

## Risks

The one-time client migration is large even though the target overlay is small. Behavior inventories and per-feature acceptance tests reduce the risk of silently dropping fork capabilities.

Some existing fork features may expose missing upstream extension points. Treating each as a general extension patch requires more initial design work than copying the fork file, but it bounds future merge cost.

Upstream may make a cross-cutting change that affects many plugin interfaces without producing Git conflicts. Overlay impact analysis, package typechecks, assembled product evidence, and independent review reduce this risk but cannot prove semantic compatibility without behavior-specific tests.

Agent resolution may be unavailable, incorrect, or over-broad. The candidate-only write scope, manifest budgets, required evidence, independent review, and branch protection keep such a failure out of `master`.
