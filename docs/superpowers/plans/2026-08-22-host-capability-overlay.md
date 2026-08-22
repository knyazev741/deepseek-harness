# Host Capability Overlay Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the fork onto the selected upstream Host baseline while preserving required non-UI behavior as fork-owned capabilities or narrowly budgeted patches and removing the reverted Codex implementation.

**Architecture:** The migration first captures observable behavior and then performs one normal upstream merge in an isolated worktree. Durable fork metadata uses independent services, projections, settings, and Typert remotes instead of widening upstream session headers or API Proxy methods. Streaming timeout policy uses the documented `llm/stream` waterfall. Only bounded compaction input and per-call subagent model selection remain candidate product patches; each is omitted when the selected upstream already proves equivalent behavior.

**Tech Stack:** Cordis services and effects, Typert Remote generation, Zod wire validation, Vitest, keyless snapshot tests, Git worktrees.

**Spec:** `docs/superpowers/specs/2026-08-22-plugin-first-fork-overlay-design.md`

## Global Constraints

- Execute in a clean isolated worktree created from the Plan 1 checkpoint; do not use the dirty primary checkout.
- Create an annotated recovery tag before the upstream merge and do not move or delete it during migration.
- Merge `upstream/master` normally with `--no-commit --no-ff`; do not use `-X ours`, `-X theirs`, checkout-side selection, or package-wide copies.
- A behavior already supplied by upstream is recorded as `upstreamed` and is not reimplemented.
- Every model-visible fork fact is a durable session event and projection.
- A Host capability includes Service Definition, Provider, Consumer, lifecycle tests, and failure tests.
- `external-session-codex`, Codex process/wire fixtures, and Codex UI are absent after this plan.
- Existing unrelated untracked Agent Notes and probe scripts remain untouched.

---

## File Structure

- `.fork/features.yaml`: stable legacy-feature inventory and disposition evidence.
- `.fork/migration/upstream-merge.md`: selected SHA, recovery tag, conflicts, and resolution commits.
- `.fork/migration/upstream-commit`: one line containing the immutable selected upstream SHA.
- `packages/fork/session-source/`: durable source-marker event, projection, GitHub Actions producer, and Typert-readable projection data.
- `packages/fork/workspace-session-state/`: persistent pinned-session service and Typert Remote.
- `packages/fork/llm-first-chunk-timeout/`: configurable `llm/stream` waterfall wrapper.
- `packages/fork/external-session/`: provider-neutral Service Definition and durable external transcript vocabulary only.
- `packages/compaction/compaction-basic/`: bounded-input product patch only when upstream lacks the acceptance behavior.
- `packages/subagent/tool-subagent/`: per-call model-selection product patch only when upstream lacks the acceptance behavior.
- `packages/bundle/fork-base/`: composition rows for fork Host plugins, applied after upstream base.

### Task 1: Capture the legacy feature inventory and acceptance mapping

**Files:**
- Create: `.fork/features.yaml`
- Create: `.fork/migration/README.md`
- Test: `scripts/fork-overlay/features.spec.ts`

**Interfaces:**
- Produces a list of `{ id, sourceCommits, requiredBehavior, evidence, disposition, replacement }` records consumed by Plans 3 and 4.

- [ ] **Step 1: Write the failing inventory-schema test**

The test loads `.fork/features.yaml`, rejects unknown keys and duplicate ids, and requires these exact ids:

```ts
const REQUIRED_FEATURES = [
  'compaction-bounded-input',
  'stream-first-chunk-idle-timeout',
  'workspace-copy-session-id',
  'workspace-mark-unread',
  'workspace-background-filter',
  'workspace-session-pin',
  'github-actions-session-source',
  'subagent-recursive-fork',
  'subagent-per-call-model-routing',
  'external-session-generic',
  'external-session-codex',
] as const
```

Allowed dispositions are `preserved`, `adapted`, `upstreamed`, `retired`, and `deferred`. Every record requires at least one exact test file in `evidence`. `retired` and `deferred` records require a non-empty `replacement` explanation.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run scripts/fork-overlay/features.spec.ts`

Expected: FAIL because the inventory is absent.

- [ ] **Step 3: Write the inventory with pre-merge dispositions**

Use the commit sources already identified: `078d3db591`, `eb25108045`, `842170d111`, `cc565b1065`, `44c01788c1`, `3a1558b55e..72ff0d079c`, and `3eb7008e09`. Set `external-session-codex` to `deferred` with replacement `A later opt-in Codex provider and Web bundle; no Codex runtime ships in this migration`. Set every other record to `adapted` until the upstream audit proves it `upstreamed`.

For each record, write one sentence naming observable behavior, not implementation. For example:

```yaml
- id: workspace-session-pin
  sourceCommits: [3eb7008e09]
  requiredBehavior: A user can pin and unpin a session, the order survives reload, and another workspace is unaffected.
  evidence:
    - packages/fork/workspace-session-state/tests/service.spec.ts
    - packages/fork/ui-workspace-overlay/tests/workspace-overlay.client.spec.tsx
  disposition: adapted
  replacement: Fork-owned settings-backed Host service, Typert Remote, and UI contribution.
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm exec vitest run scripts/fork-overlay/features.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit the inventory**

```bash
git add .fork/features.yaml .fork/migration/README.md scripts/fork-overlay/features.spec.ts
git commit -m "docs(fork): inventory fork behaviors"
```

### Task 2: Establish the upstream migration baseline

**Files:**
- Create: `.fork/migration/upstream-merge.md`
- Create: `.fork/migration/upstream-commit`
- Modify: conflicted source files only to complete the normal merge.

**Interfaces:**
- Produces: a merge commit whose second parent is the exact selected upstream SHA and whose client subtree is not accepted until Plan 3.

- [ ] **Step 1: Create the isolated worktree and recovery tag**

From the primary checkout, run the worktree procedure from `superpowers:using-git-worktrees`. Resolve `START_SHA=$(git rev-parse HEAD)`, create branch `codex/plugin-first-overlay` in sibling worktree `/Users/knyaz/deepseek-harness-plugin-first`, and then run in that worktree:

```bash
git tag -a fork-overlay-recovery-2026-08-22 -m "pre plugin-first overlay migration" "$START_SHA"
git fetch upstream master
git rev-parse upstream/master
```

Record the resulting 40-character upstream SHA in `.fork/migration/upstream-merge.md` and as the only line of `.fork/migration/upstream-commit`.

- [ ] **Step 2: Start the normal merge and preserve evidence**

```bash
git merge --no-commit --no-ff upstream/master
git status --short
git diff --name-only --diff-filter=U
```

Record every conflicted path. Do not resolve client paths by copying either side; Plan 3 establishes the complete upstream client after Host conflicts are resolved.

- [ ] **Step 3: Resolve Host conflicts by behavior ownership**

For each Host conflict, first read the upstream commit that touched the file and the owning package README. Keep upstream structure. Move fork behavior into the packages named by this plan. If a fork behavior has not yet been moved, choose the upstream file and let its acceptance test remain RED until the owning task implements it. Delete obsolete old fork paths only when the replacement task names them.

- [ ] **Step 4: Commit the merge checkpoint**

After `git diff --name-only --diff-filter=U` prints nothing, run `git add -A` in this clean isolated worktree and `git commit`. Use Git's generated merge message.

Verify with:

```bash
git rev-list --parents -n 1 HEAD
git diff --name-only HEAD^2..HEAD -- packages/client
```

Expected: two parents; no `ours`/`theirs` strategy marker in the recorded procedure.

### Task 3: Preserve GitHub Actions source as a plugin-owned session event

**Files:**
- Create: `packages/fork/session-source/package.json`
- Create: `packages/fork/session-source/src/index.ts`
- Create: `packages/fork/session-source/src/projection.ts`
- Create: `packages/fork/session-source/src/types.ts`
- Create: `packages/fork/session-source/tests/session-source.spec.ts`
- Create: `packages/fork/session-source/README.md`
- Create paired README translation files.
- Modify: root TypeScript face configs and package catalogs through their generators.

**Interfaces:**
- Produces durable event `fork/session-source` with `{ source: 'github-actions' }`.
- Produces projection key `forkSessionSource` with value `'github-actions' | undefined`.
- Consumes `Config.enabledWhenEnv: string`, default `GITHUB_ACTIONS`.

- [ ] **Step 1: Write failing event and projection tests**

```ts
it('appends one source event only in GitHub Actions', async () => {
  const ctx = await fixture({ GITHUB_ACTIONS: 'true' })
  const session = ctx.sessions.create(SessionId('ci'))
  expect(session.events.filter(event => event.type === 'fork/session-source')).toHaveLength(1)
  expect(ctx.sessionProjections.project(session).forkSessionSource).toBe('github-actions')
})

it('does not alter the upstream SessionHeader origin', async () => {
  const ctx = await fixture({ GITHUB_ACTIONS: 'true' })
  const session = ctx.sessions.create(SessionId('ci'))
  expect(session.header.origin).toBeUndefined()
})
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run packages/fork/session-source/tests/session-source.spec.ts`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Implement the event producer and projection**

Declare the event through `SessionEventMap` merging, append it from a `ctx.on('session/created', ...)` effect only when the configured environment key equals `true`, and register the projection through the existing projection registry. The fold is last-wins for known values and rejects an unreadable payload.

- [ ] **Step 4: Run package tests and snapshot evidence**

Run: `pnpm exec vitest run packages/fork/session-source`

Add or update the smallest keyless headless snapshot named `fork session source projection` so a GitHub Actions fixture exposes `forkSessionSource` without changing ordinary output. Run `pnpm run test:snapshot -- -t "fork session source projection"`.

- [ ] **Step 5: Commit**

```bash
git add packages/fork/session-source tsconfig.host.json packages/README.md docs/config-catalog.md
git commit -m "feat(fork): project GitHub Actions session source"
```

### Task 4: Add persistent workspace session pins as a Typert capability

**Files:**
- Create: `packages/fork/workspace-session-state/package.json`
- Create: `packages/fork/workspace-session-state/src/index.ts`
- Create: `packages/fork/workspace-session-state/src/types.ts`
- Create: `packages/fork/workspace-session-state/tests/service.spec.ts`
- Create: `packages/fork/workspace-session-state/README.md`
- Create paired README translation files.
- Modify: `packages/api/remotes/src/client/index.ts`
- Modify generated Typert outputs through repository generators.

**Interfaces:**
- Produces service `ctx.forkWorkspaceSessionState`.
- Produces Typert namespace `forkWorkspaceSessionState` with `list()` and `setPinned()`.

```ts
export interface ForkWorkspaceSessionStateView {
  readonly revision: number
  readonly pinnedSessionIds: readonly SessionId[]
}

export class ForkWorkspaceSessionState extends TypertRemoteService {
  @Remote()
  list(): Promise<ForkWorkspaceSessionStateView>

  @Remote()
  setPinned(input: { sessionId: SessionId; pinned: boolean; expectedRevision: number }): Promise<ForkWorkspaceSessionStateView>
}
```

- [ ] **Step 1: Write failing service tests**

Prove pin/unpin idempotence, stable insertion order, persistence across provider reload, conflict on a stale revision, rejection of a session id not present in the workspace registry, and effect-owned Remote withdrawal.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run packages/fork/workspace-session-state/tests/service.spec.ts`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Implement with the settings capability**

Store one validated value under namespace `fork.workspaceSessionState`, key `pins`, as `{ revision, sessionIds }`. Resolve and validate the referenced session against the authoritative workspace service before writes. Use optimistic revision checks so two browsers cannot silently overwrite each other. Expose only the generated Typert Remote; do not add methods to API Proxy.

- [ ] **Step 4: Run focused tests and generated-artifact checks**

Run: `pnpm exec vitest run packages/fork/workspace-session-state packages/api/remotes`

Run: `pnpm run gen-cordis-api`

Run: `pnpm run typecheck:contracts-ready`

Expected: PASS and no hand-edited generated artifact.

- [ ] **Step 5: Commit**

```bash
git add packages/fork/workspace-session-state packages/api/remotes/src/client/index.ts packages/README.md docs tsconfig.host.json tsconfig.client.json
git commit -m "feat(fork): persist workspace session pins"
```

### Task 5: Add first-chunk idle timeout as an LLM waterfall plugin

**Files:**
- Create: `packages/fork/llm-first-chunk-timeout/package.json`
- Create: `packages/fork/llm-first-chunk-timeout/src/index.ts`
- Create: `packages/fork/llm-first-chunk-timeout/tests/timeout.spec.ts`
- Create: `packages/fork/llm-first-chunk-timeout/README.md`
- Create paired README translation files.

**Interfaces:**
- Consumes the documented `llm/stream` waterfall and delegates with `next()`.
- Config: `{ firstChunkIdleTimeoutMs: number }`, positive integer, default `120000`.

- [ ] **Step 1: Write failing waterfall tests**

Prove a stream that emits before the deadline passes unchanged, a silent stream aborts with the existing retryable timeout error, the timer is cleared after the first chunk, caller cancellation wins, and absence of the plugin leaves upstream behavior unchanged.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run packages/fork/llm-first-chunk-timeout/tests/timeout.spec.ts`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Implement the wrapper**

Register one waterfall listener with `ctx.on('llm/stream', async (request, next) => ...)`, call `next()` exactly once, and wrap only the returned async iterable until its first yielded chunk. Do not edit DeepSeek, Pi AI, retry, or compaction packages. Config parsing fails at plugin load for zero, negative, fractional, or unsafe values.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm exec vitest run packages/fork/llm-first-chunk-timeout`

Run: `pnpm run typecheck:contracts-ready`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fork/llm-first-chunk-timeout packages/README.md docs/config-catalog.md tsconfig.host.json
git commit -m "feat(fork): bound first LLM chunk idle time"
```

### Task 6: Reconcile bounded compaction and subagent routing

**Files:**
- Modify when required: `packages/compaction/compaction-basic/src/config.ts`
- Modify when required: `packages/compaction/compaction-basic/src/summarizer.ts`
- Test when required: `packages/compaction/compaction-basic/tests/compaction-basic.spec.ts`
- Modify when required: `packages/subagent/tool-subagent/src/index.ts`
- Test when required: `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`
- Modify: `.fork/features.yaml`

**Interfaces:**
- Compaction config adds `maxSummarizationInputTokens: number`, positive integer, default `60000`, only if upstream lacks equivalent bounded multi-pass behavior.
- Subagent tool schema adds optional `model?: string` and `reasoning_effort?: ReasoningEffortId`, only if upstream lacks an equivalent per-call route.

- [ ] **Step 1: Run the legacy acceptance cases against the new upstream tree**

Port only the behavior-level tests from commits `078d3db591` and `3eb7008e09` into the current upstream test structure. Run them before implementation.

Expected: each feature either passes unchanged, proving `upstreamed`, or fails for the missing behavior.

- [ ] **Step 2: Record upstreamed behavior without a patch**

If all acceptance cases for a feature pass, set its `.fork/features.yaml` disposition to `upstreamed`, point `replacement` to the exact upstream package/test, and make no source modification for that feature.

- [ ] **Step 3: Implement only failing behavior with its declared budget**

For compaction, bound the history presented to each summarization request while retaining the newest region and allowing subsequent passes; do not truncate the durable session log. Budget: at most 3 upstream source files and 220 changed lines.

For subagent routing, validate model and reasoning effort at the tool JSON boundary, forward them in the provider request's resolved agent options, and keep omission identical to upstream. Budget: at most 2 upstream source files and 160 changed lines.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run packages/compaction/compaction-basic packages/subagent/tool-subagent`

Expected: PASS.

- [ ] **Step 5: Commit independently by feature**

```bash
git add .fork/features.yaml packages/compaction/compaction-basic
git commit -m "fix(compaction): bound summarization input"
```

```bash
git add .fork/features.yaml packages/subagent/tool-subagent
git commit -m "feat(subagent): route model per delegation"
```

Skip the corresponding commit when the feature is upstreamed and only the inventory changed; fold that inventory edit into the next documentation commit.

### Task 7: Retain only the provider-neutral external-session seam

**Files:**
- Create: `packages/fork/external-session/package.json`
- Create: `packages/fork/external-session/src/index.ts`
- Create: `packages/fork/external-session/src/types.ts`
- Create: `packages/fork/external-session/tests/service.spec.ts`
- Create: `packages/fork/external-session/README.md`
- Create paired README translation files.
- Delete: `packages/external/external-session-codex/`
- Delete: obsolete `packages/external/external-session-bridge/` when no non-Codex provider consumes it.
- Delete: `packages/interaction/external-permission/` when only Codex consumes it.
- Archive with `dsh-archive-agent-notes`: the implemented Phase 1 external-session note and the superseded proposed external-session note, including their translation pairs.
- Delete: `.agents/plans/2026-08-18-external-sessions/`
- Modify: `.fork/features.yaml`

**Interfaces:**
- Produces a merge-extensible `ExternalSessionModeMap` and registry service with effect-owned `register(mode, provider): () => void`.
- No default provider, process runner, permission bridge, transcript renderer, or bundle row.

- [ ] **Step 1: Write failing seam tests**

Prove unique mode ids, disposer ownership, provider lookup failure, an empty registry as valid composition, and type-safe merge extension. Do not port Codex wire fixtures.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run packages/fork/external-session/tests/service.spec.ts`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Implement the minimal Service Definition**

Expose registration and lookup only. Keep transcript event vocabulary out until a real provider establishes the concrete durable facts needed by the Codex follow-on. Update `external-session-generic` to `adapted` and `external-session-codex` to `deferred`. Invoke `dsh-archive-agent-notes` before moving the active Phase 1/proposed notes so the archive records the correct supersession state; delete the obsolete execution plans after their owning notes are archived.

- [ ] **Step 4: Delete Codex-only paths and prove absence**

Run:

```bash
git grep -n -E 'external-session-codex|codex app-server|codex/mcp|CodexProvider' -- packages apps examples .github || true
```

Expected: no runtime or default-composition match. Historical Agent Notes may name the retired implementation and remain immutable.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm exec vitest run packages/fork/external-session`

```bash
git add -A packages/external packages/interaction/external-permission packages/fork/external-session .agents/notes .agents/plans/2026-08-18-external-sessions .fork/features.yaml packages/README.md tsconfig.host.json
git commit -m "refactor(external): retain provider-neutral session seam"
```

### Task 8: Compose the fork Host layer

**Files:**
- Create: `packages/bundle/fork-base/package.json`
- Create: `packages/bundle/fork-base/cordis.patch.yml`
- Create: `packages/bundle/fork-base/src/index.ts`
- Create: `packages/bundle/fork-base/src/invariant.ts`
- Create: `packages/bundle/fork-base/tests/fork-base.spec.ts`
- Create: `packages/bundle/fork-base/README.md`
- Create paired README translation files.

**Interfaces:**
- Produces a bundle applied after upstream `dsh-base`.
- Mounts `fork-session-source`, `fork-workspace-session-state`, and `fork-llm-first-chunk-timeout`; mounts no Codex provider.

- [ ] **Step 1: Write failing bundle tests**

Dump the assembled config and assert the three fork rows appear after their upstream dependencies, ids are unique, each row can be disabled or reconfigured by a later patch, and no upstream base row is replaced.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run packages/bundle/fork-base/tests/fork-base.spec.ts`

Expected: FAIL because the bundle is absent.

- [ ] **Step 3: Implement the bundle**

The patch contains only `insert` rows. Give deployment-varying timeout values explicit config. Do not edit `packages/bundle/base/cordis.patch.yml`.

- [ ] **Step 4: Run package and configuration gates**

Run: `pnpm exec vitest run packages/bundle/fork-base packages/fork`

Run: `pnpm run verify-cordis-config`

Run: `pnpm run verify-package-invariants`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bundle/fork-base packages/README.md docs/config-catalog.md pnpm-lock.yaml tsconfig.host.json
git commit -m "feat(fork): compose host overlay bundle"
```

## Plan 2 Acceptance

- The migration commit has the selected `upstream/master` SHA as a parent and records no merge-side preference.
- `.fork/features.yaml` contains one disposition and runnable evidence for every known committed fork feature.
- Session source, workspace pins, and first-chunk timeout are plugin-owned.
- Compaction and subagent patches exist only for behavior not already supplied upstream and remain within their budgets.
- The default upstream base bundle is unchanged.
- No Codex runtime, wire fixture, permission bridge, UI, or default composition remains.
