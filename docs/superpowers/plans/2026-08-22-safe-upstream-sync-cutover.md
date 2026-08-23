# Safe Upstream Sync and Cutover Implementation Plan

English | [中文](2026-08-22-safe-upstream-sync-cutover.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the complete overlay manifest, replace fork-preferred sync with a fail-closed candidate workflow, prove conflict and UI failure simulations, and merge the reviewed migration into `master`.

**Architecture:** Repository scripts, not workflow prose, own merge preparation, context generation, report validation, and simulations. The workflow creates a candidate from `master`, performs a normal merge, lets a configured repository agent edit only the candidate when conflicts exist, validates its structured disposition report, then runs overlay and affected-product evidence. A second agent reviews the completed candidate. The final cutover uses the same scripts for a dry run before the migration PR can merge.

**Tech Stack:** TypeScript, Git plumbing, GitHub Actions, DeepSeek Harness headless runner for future CI resolution/review, Vitest temporary Git fixtures, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-08-22-plugin-first-fork-overlay-design.md`

## Global Constraints

- The candidate branch is `sync/upstream-master`; automation never writes directly to `master`.
- Normal merge only: no `-X ours`, `-X theirs`, checkout-side resolution, blanket workflow exclusion, or force push without lease.
- A missing resolver, invalid resolver report, unresolved conflict, failed gate, or risky reviewer verdict leaves the PR unmergeable.
- Resolver and reviewer are separate agent runs with separate prompts and artifacts.
- Workflow exclusions cover only the two fork-owned workflow files recorded in the manifest.
- `.fork/overlay.yaml` names the exact immutable upstream SHA integrated into the candidate.
- Every final tree difference is covered exactly once before the gate is added to CI.
- No deployment step is introduced.

---

## File Structure

- `.fork/overlay.yaml`: active complete ownership inventory.
- `scripts/upstream-sync/types.ts`: context and report types.
- `scripts/upstream-sync/prepare.ts`: normal merge preparation and conflict fact collection.
- `scripts/upstream-sync/context.ts`: repository-grounded resolver/reviewer input.
- `scripts/upstream-sync/report.ts`: strict JSON report parsing and disposition validation.
- `scripts/upstream-sync/finalize.ts`: unresolved-state, manifest-SHA, generated-output, and commit checks.
- `scripts/upstream-sync/simulate.spec.ts`: temporary-repository merge and failure simulations.
- `scripts/run-gates.ts`: ordinary-change activation of the overlay gate.
- `.github/review/upstream-resolver-task.md`: resolver contract.
- `.github/review/upstream-reviewer-task.md`: independent reviewer contract.
- `.github/workflows/upstream-sync.yml`: candidate creation only.
- `.github/workflows/upstream-review.yml`: evidence, independent review, and guarded PR merge.

### Task 1: Create the complete active overlay manifest

**Files:**
- Create: `.fork/overlay.yaml`
- Modify: `.fork/README.md`
- Modify: package/TypeScript/generated files only when the verifier identifies an actual uncovered final diff.

**Interfaces:**
- Consumes the verifier from Plan 1 and the exact upstream merge parent from Plan 2.
- Produces a zero-diagnostic `pnpm run verify-fork-overlay` result.

- [ ] **Step 1: Set the immutable upstream commit**

```bash
UPSTREAM_PARENT=$(tr -d '\n' < .fork/migration/upstream-commit)
git cat-file -e "$UPSTREAM_PARENT^{commit}"
```

Create `.fork/overlay.yaml` with `schemaVersion: 1` and the printed SHA. Do not write `upstream/master` or another moving ref into the file.

- [ ] **Step 2: Add fork-owned and composition entries**

Create stable entries for these exact trees and files when present in the final diff:

| id | kind | path coverage |
|---|---|---|
| `fork-overlay-tooling` | `fork-owned` | `scripts/fork-overlay/`, `scripts/verify-fork-overlay.ts`, `.fork/overlay.yaml`, `.fork/README.md`, `.fork/features.yaml`, `.fork/migration/` |
| `fork-overlay-design` | `fork-owned` | the 2026-08-22 spec, roadmap, four plan files, overlay-manifest Agent Note pair, and completed-migration Agent Note pair by exact path |
| `fork-session-source` | `fork-owned` | `packages/fork/session-source/` |
| `fork-workspace-session-state` | `fork-owned` | `packages/fork/workspace-session-state/` |
| `fork-first-chunk-timeout` | `fork-owned` | `packages/fork/llm-first-chunk-timeout/` |
| `fork-external-session-seam` | `fork-owned` | `packages/fork/external-session/` |
| `fork-workspace-ui` | `fork-owned` | `packages/fork/ui-workspace-overlay/` |
| `fork-base-composition` | `composition` | `packages/bundle/fork-base/` |
| `fork-web-composition` | `composition` | `packages/bundle/fork-web/`, `examples/fork-web/` |
| `fork-web-evidence` | `fork-owned` | `scripts/web-composition/`, `scripts/verify-web-composition.ts`, the exact fork Web smoke file |
| `fork-upstream-sync` | `workflow` | the exact two workflow files, two review prompt files, review settings file, and `scripts/upstream-sync/` |

Each entry names its exact Agent Note, verification targets, owner, and a retirement condition. Do not cover root `package.json`, `pnpm-lock.yaml`, TypeScript faces, package indexes, or generated catalogs with a broad tree; list each under the composition entry that causes it through exact coverage and `generatedBy`.

- [ ] **Step 3: Add bounded patch entries**

Add `ui-workspace-contributions` as `extension-patch` with the exact Plan 3 source/test/README files and budget `{ maxFiles: 6, maxChangedLines: 260 }`.

Add `bounded-compaction-input` as `product-patch` with budget `{ maxFiles: 3, maxChangedLines: 220 }` only when `.fork/features.yaml` says `adapted`.

Add `subagent-per-call-model-routing` as `product-patch` with budget `{ maxFiles: 2, maxChangedLines: 160 }` only when `.fork/features.yaml` says `adapted`.

Add `fork-web-profile-template` as `product-patch` for the exact `packages/boot/app-boot/src/profile.ts` and `packages/boot/app-boot/tests/profile.spec.ts` paths with budget `{ maxFiles: 2, maxChangedLines: 40 }`.

- [ ] **Step 4: Eliminate every uncovered or overlapping path**

Run: `pnpm run verify-fork-overlay`

For `uncovered-path`, either move behavior into the owning fork package, add the exact generated/composition path to its existing entry, or create a separately justified bounded patch. For `overlapping-coverage`, narrow entries; never make the verifier choose a winner. For `stale-entry`, remove the entry and update `.fork/features.yaml` to `upstreamed` or `retired`.

Expected: `fork-overlay: PASS`.

- [ ] **Step 5: Activate the gate for ordinary changes and commit**

Add `pnpmScript('fork-overlay', 'verify-fork-overlay', { label: 'fork overlay' })` to `ciSharedStaticGates()` and `check-all`, then extend the existing `scripts/run-gates.spec.ts` assertions so `ci-static` and `check-all` each contain the gate exactly once. Run `pnpm exec vitest run scripts/run-gates.spec.ts` and `pnpm run verify-fork-overlay`; both must pass.

```bash
git add .fork/overlay.yaml .fork/README.md .fork/features.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.host.json tsconfig.client.json packages/README.md docs scripts/run-gates.ts scripts/run-gates.spec.ts
git commit -m "feat(fork): activate overlay inventory"
```

### Task 2: Build merge preparation and report contracts

**Files:**
- Create: `scripts/upstream-sync/types.ts`
- Create: `scripts/upstream-sync/prepare.ts`
- Create: `scripts/upstream-sync/context.ts`
- Create: `scripts/upstream-sync/report.ts`
- Test: `scripts/upstream-sync/prepare.spec.ts`
- Test: `scripts/upstream-sync/report.spec.ts`

**Interfaces:**
- Produces `pnpm exec tsx scripts/upstream-sync/prepare.ts --upstream "$UPSTREAM_SHA" --context "$RUNNER_TEMP/sync-context.json"`.
- Produces `validateResolutionReport(report, context): ResolutionReport`.

```ts
export interface OverlayDisposition {
  readonly entryId: string
  readonly disposition: 'preserved' | 'adapted' | 'upstreamed' | 'retired'
  readonly filesChanged: readonly string[]
  readonly behavior: string
  readonly testsRun: readonly string[]
  readonly residualRisk: string
}

export interface ResolutionReport {
  readonly schemaVersion: 1
  readonly upstreamCommit: string
  readonly dispositions: readonly OverlayDisposition[]
}

export interface SyncContext {
  readonly forkCommit: string
  readonly upstreamCommit: string
  readonly mergeBase: string
  readonly upstreamCommits: readonly { sha: string; subject: string }[]
  readonly conflicts: readonly { path: string; stages: readonly (1 | 2 | 3)[]; entryIds: readonly string[] }[]
  readonly affectedEntries: readonly string[]
  readonly requiredVerification: readonly VerificationTarget[]
}
```

- [ ] **Step 1: Write failing prepare tests**

In temporary repositories, prove a conflict-free merge writes context and leaves a merge ready to commit; a content conflict, modify/delete conflict, and rename/delete conflict remain unmerged and appear with stage facts; a fork-owned path collision appears as a blocker before merge; a missing exact upstream commit fails.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run scripts/upstream-sync/prepare.spec.ts scripts/upstream-sync/report.spec.ts`

Expected: FAIL because the scripts are absent.

- [ ] **Step 3: Implement preparation without a shell**

Use `execFile` with explicit Git arguments. `prepare.ts` verifies a clean candidate, loads the old manifest, checks the incoming commit, runs `git merge --no-commit --no-ff` with the requested upstream SHA, rewrites only `upstreamCommit` in the working-tree manifest to that SHA, and writes context after Git settles. Preserve the old manifest in memory for ownership and impact analysis. Exit codes: `0` means conflict-free merge ready; `2` means conflicts require a resolver; `1` means preparation itself failed. It never calls `git add`, checkout-side resolution, commit, push, or reset.

- [ ] **Step 4: Implement strict report validation**

Require exactly one disposition for every affected overlay entry and none for unaffected ids. `filesChanged` must be a subset of the candidate diff and each file must be covered by that entry. `testsRun` must equal or include every manifest verification target rendered into its canonical command. `upstreamed` and `retired` entries must be stale in the post-resolution diff; `preserved` and `adapted` entries must remain covered.

- [ ] **Step 5: Run and commit**

Run: `pnpm exec vitest run scripts/upstream-sync/prepare.spec.ts scripts/upstream-sync/report.spec.ts`

```bash
git add scripts/upstream-sync/types.ts scripts/upstream-sync/prepare.ts scripts/upstream-sync/context.ts scripts/upstream-sync/report.ts scripts/upstream-sync/prepare.spec.ts scripts/upstream-sync/report.spec.ts
git commit -m "feat(sync): prepare normal upstream merges"
```

### Task 3: Finalize only a resolved, verified candidate

**Files:**
- Create: `scripts/upstream-sync/finalize.ts`
- Test: `scripts/upstream-sync/finalize.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `pnpm run finalize-upstream-sync -- --upstream "$UPSTREAM_SHA" --report "$RUNNER_TEMP/resolution-report.json"`.

- [ ] **Step 1: Write failing finalizer tests**

Reject unresolved index stages, absent `MERGE_HEAD`, a report SHA different from `MERGE_HEAD`, a manifest SHA different from the incoming commit, invalid report dispositions, overlay diagnostics, a dirty unstaged resolver edit, and a tree identical to pre-merge fork. Prove a valid candidate regenerates only declared generated outputs and creates one merge commit.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run scripts/upstream-sync/finalize.spec.ts`

Expected: FAIL because the finalizer is absent.

- [ ] **Step 3: Implement fail-closed finalization**

The finalizer performs these checks in order: no unmerged entries; report valid; `.fork/overlay.yaml` records `MERGE_HEAD`; `pnpm install --lockfile-only`; declared catalog generators; overlay verifier; required focused verification. It stages only files already changed by the merge/resolver plus declared generated outputs, then commits with `git commit --no-edit`. Any failure leaves the candidate and diagnostics intact without pushing.

Add:

```json
"finalize-upstream-sync": "tsx scripts/upstream-sync/finalize.ts"
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm exec vitest run scripts/upstream-sync/finalize.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/upstream-sync/finalize.ts scripts/upstream-sync/finalize.spec.ts package.json
git commit -m "feat(sync): finalize verified candidates"
```

### Task 4: Replace the resolver and reviewer prompts

**Files:**
- Create: `.github/review/upstream-resolver-task.md`
- Create: `.github/review/upstream-reviewer-task.md`
- Delete: `.github/review/reviewer-task.txt`
- Modify: `.github/review/headless-settings.yaml`
- Delete: `scripts/import-review-session.sh`
- Test: `scripts/upstream-sync/prompts.spec.ts`

**Interfaces:**
- Resolver reads the generated `SyncContext`, edits only the candidate, runs exact required checks, and writes `resolution-report.json`.
- Reviewer reads context, report, complete diff, and evidence; writes `{ safe, summary, risks, rejectedDispositions }`.

- [ ] **Step 1: Write failing prompt-contract tests**

Assert the resolver prompt forbids whole-side selection, master writes, check suppression, deployment, and fabricated test evidence; requires upstream intent, one disposition per entry, exact report path, and unresolved-conflict check. Assert the reviewer is independent, rejects unregistered diffs and weakened tests, and never treats compilation alone as sufficient.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run scripts/upstream-sync/prompts.spec.ts`

Expected: FAIL because the new prompts are absent.

- [ ] **Step 3: Write repository-grounded prompts**

The resolver begins by reading the absolute file named by `DSH_SYNC_CONTEXT_PATH`, `.fork/overlay.yaml`, affected Agent Notes, and each upstream commit listed in context. It writes the report to the absolute file named by `DSH_SYNC_REPORT_PATH`; both paths live under `RUNNER_TEMP` and never enter the candidate diff. It may use `git checkout --ours/--theirs` only for a fork-owned exact path after the context proves the other side has no ownership collision; it may never use those commands for an upstream-owned package. It ends only after writing strict JSON and leaving no unmerged stages.

The reviewer receives a fresh DSH home and must inspect `master...HEAD`, `resolution-report.json`, `fork-overlay` output, focused checks, and both Web evidence outputs.

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm exec vitest run scripts/upstream-sync/prompts.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .github/review scripts/import-review-session.sh scripts/upstream-sync/prompts.spec.ts
git commit -m "ci(sync): define resolver and reviewer contracts"
```

### Task 5: Rewrite the GitHub workflows around candidate-only resolution

**Files:**
- Modify: `.github/workflows/upstream-sync.yml`
- Modify: `.github/workflows/upstream-review.yml`
- Test: `scripts/upstream-sync/workflows.spec.ts`

**Interfaces:**
- Sync uploads `sync-context`, `resolution-report`, and command logs.
- Review merges only when required gates pass and reviewer returns `safe: true`.

- [ ] **Step 1: Write failing workflow policy tests**

Parse both YAML files and reject `-X ours`, `-X theirs`, `checkout --ours`, `checkout --theirs`, `git push -f`, complete `.github/workflows` restoration, direct `master` checkout for writes, `continue-on-error` on required evidence, and any deploy command. Require `--force-with-lease` only for replacing the candidate branch, exact workflow-path handling, overlay verification, both Web composition checks, resolver artifact, reviewer artifact, and PR-only merge.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run scripts/upstream-sync/workflows.spec.ts`

Expected: FAIL against the current fork-preferred workflows.

- [ ] **Step 3: Rewrite upstream-sync**

The workflow checks out `master`, fetches the exact upstream SHA, records `PREVIOUS_REMOTE_SHA=$(git rev-parse --verify refs/remotes/origin/sync/upstream-master 2>/dev/null || printf '%040d' 0)`, creates `sync/upstream-master`, and runs `prepare.ts` with context under `RUNNER_TEMP`. Exit `1` fails. Exit `0` with no affected entries writes a zero-entry report. Exit `0` with affected entries or exit `2` starts the headless resolver/impact agent with the committed prompt; on exit `2` it must also resolve conflicts. Then `finalize.ts` validates the report, the branch is pushed with `--force-with-lease=refs/heads/sync/upstream-master:$PREVIOUS_REMOTE_SHA`, and the PR is opened or updated.

Do not delete all upstream workflow changes. The merge may modify upstream-owned workflows normally; only the two fork workflow files in the manifest remain fork-owned and collision-checked.

- [ ] **Step 4: Rewrite upstream-review**

Run `pnpm install --frozen-lockfile`, `pnpm run verify-fork-overlay`, affected focused targets from the report, `pnpm run typecheck:contracts-ready`, built package invariants for changed runtime packages, `verify-web-composition` for `web` and `fork-web`, and the built browser smoke. Start a fresh independent review agent only after checks pass. Merge the PR with a merge commit only when the strict verdict is safe and GitHub required checks are green.

- [ ] **Step 5: Run policy tests and commit**

Run: `pnpm exec vitest run scripts/upstream-sync/workflows.spec.ts`

```bash
git add .github/workflows/upstream-sync.yml .github/workflows/upstream-review.yml scripts/upstream-sync/workflows.spec.ts
git commit -m "ci(sync): resolve upstream on candidate branches"
```

### Task 6: Add complete sync and broken-Web simulations

**Files:**
- Create: `scripts/upstream-sync/simulate.spec.ts`
- Create: `scripts/upstream-sync/fixtures/` only for non-generated fixture source.

**Interfaces:**
- Produces deterministic evidence for conflict-free, conflict, collision, stale, budget, and Web artifact failure cases.

- [ ] **Step 1: Write the simulation matrix**

Create a temporary bare upstream, fork clone, and candidate clone per test. Cover:

1. conflict-free upstream edit reaches the candidate;
2. content conflict exits `2` and cannot finalize without a report;
3. modify/delete conflict stays unresolved;
4. rename/delete conflict stays unresolved;
5. upstream creates a fork-owned path and preparation fails before resolution;
6. upstream implements a patch and a preserved report fails as stale;
7. patch changed lines exceed budget;
8. resolver report omits one affected entry;
9. built HTML lacks CSS;
10. fork plugin disappears from boot metadata.

- [ ] **Step 2: Run and confirm failures before all fixtures are wired**

Run: `pnpm exec vitest run scripts/upstream-sync/simulate.spec.ts`

Expected: RED until the helpers drive every failure arm.

- [ ] **Step 3: Complete the fixture harness**

Use explicit temporary paths and local Git remotes. Do not call the network, GitHub, or a real model. Resolver success is represented by a fixture callback that edits the conflicted file and writes a strict report; this tests orchestration, not model quality.

- [ ] **Step 4: Run the matrix and overlay tests**

Run: `pnpm exec vitest run scripts/upstream-sync scripts/fork-overlay scripts/web-composition`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/upstream-sync/simulate.spec.ts scripts/upstream-sync/fixtures
git commit -m "test(sync): simulate overlay merge failures"
```

### Task 7: Run the real dry-run sync and final migration acceptance

**Files:**
- Modify only if evidence finds a real defect: owning implementation/test/doc files from Plans 1-4.
- Create: `.fork/migration/cutover-evidence.md`
- Create an Agent Note for the completed migration with EN/ZH pairing.

**Interfaces:**
- Produces reviewed evidence that the current candidate can consume a newer real or synthetic upstream commit through the production scripts.

- [ ] **Step 1: Fetch and select the dry-run target**

Fetch `upstream/master`. If it is newer than `.fork/overlay.yaml.upstreamCommit`, use that exact SHA. If it is unchanged, create a local synthetic upstream commit that modifies one upstream-owned documentation file and one non-conflicting client test fixture; record both the source SHA and synthetic SHA.

- [ ] **Step 2: Run production preparation/finalization on a throwaway candidate branch**

Create `codex/upstream-sync-dry-run` from the migration head. Run `prepare.ts`, the configured resolver only if exit `2`, report validation, and finalization. Do not push this dry-run branch.

- [ ] **Step 3: Run final proportional evidence**

Run: `pnpm run verify-fork-overlay`

Run: `pnpm exec vitest run scripts/fork-overlay scripts/upstream-sync scripts/web-composition packages/fork packages/bundle/fork-base packages/bundle/fork-web packages/client/ui-workspace`

Run: `pnpm run typecheck`

Run: `pnpm run build`

Run: `pnpm run verify-built-package-invariants`

Run: `pnpm run verify-web-composition -- --profile web`

Run: `pnpm run verify-web-composition -- --profile fork-web`

Run: `pnpm run test:web:built -- packages/client/web-react/tests/fork-web-smoke.client.spec.tsx`

Run: `pnpm run doc-sync`

Expected: all relevant tracked-tree checks PASS. Record exact commands, exit codes, SHAs, overlay entry count, patch budgets, and Web plugin rosters in `cutover-evidence.md`.

- [ ] **Step 4: Independent controller acceptance**

The controller checks the full diff from the recorded upstream parent, confirms every manifest entry against its Agent Note and feature evidence, verifies Codex absence, verifies no whole upstream package replacement, and reads the dry-run resolver/reviewer artifacts. Any finding returns to the owning task and repeats only affected checks.

- [ ] **Step 5: Commit evidence and open the migration PR**

```bash
git add .fork/migration/cutover-evidence.md .agents/notes/implemented
git commit -m "docs(notes): complete plugin-first fork migration"
git push -u origin codex/plugin-first-overlay
gh pr create --base master --head codex/plugin-first-overlay --title "refactor(fork): adopt plugin-first upstream overlay" --body-file .fork/migration/cutover-evidence.md
```

The PR is merged only after required checks and controller review. Keep the recovery tag until at least one later upstream sync completes successfully.

## Plan 4 Acceptance

- `.fork/overlay.yaml` passes with every final diff path covered exactly once.
- Workflows and scripts contain no automatic fork-side preference.
- Unresolved conflicts, missing reports, stale patches, collisions, budget violations, and broken Web artifacts fail closed.
- Resolver and reviewer are separate candidate-only agent runs.
- A real or synthetic dry-run sync passes the same production path.
- The migration PR, not automation, is the only path from the migration branch to `master`.
