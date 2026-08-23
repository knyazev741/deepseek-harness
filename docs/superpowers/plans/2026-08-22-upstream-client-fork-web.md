# Upstream Client and Fork Web Composition Implementation Plan

English | [中文](2026-08-22-upstream-client-fork-web.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the complete selected upstream client the baseline and restore fork workspace behavior through additive client plugins and a separate fork Web bundle without replacing the conversation shell, InputBar, theme, runtime, or upstream Web bundle.

**Architecture:** The migration resets only upstream-owned client paths to the merge's upstream parent, then ports behaviors against current slots and Typert remotes. Two general ui-workspace extension points expose row contributions and list policy without containing fork logic. A fork-owned UI plugin supplies copy-id, unread, background, GitHub Actions badge, and pin behavior. The fork Web bundle layers fork-base and the UI plugin after upstream Web composition. Built-artifact and browser proofs run for both compositions.

**Tech Stack:** React 19, client Cordis slots and stores, Typert Client Remote, CSS Modules, Vite, Vitest/JSDOM, built Web snapshot harness.

**Spec:** `docs/superpowers/specs/2026-08-22-plugin-first-fork-overlay-design.md`

## Global Constraints

- Begin from the Plan 2 migration branch and its exact upstream merge parent.
- Restore upstream-owned `packages/client/` files from the upstream parent before porting fork behavior.
- Do not restore legacy fork copies of `InputBar`, `ConversationRoot`, theme, runtime managers, or Web bootstrap.
- Client feature packages register through `ctx.effect()`, `ctx.slots.inject()`, or documented Client services and dispose synchronously.
- General extension patches preserve byte-for-byte observable upstream behavior when no contributor is mounted.
- Extension patch budget: at most 6 upstream ui-workspace source files and 260 changed lines, including tests but excluding generated catalogs.
- The only upstream client change outside `ui-workspace` is the generic `SessionSummary.projectionAsOfSeq` projection-watermark seam in `packages/client/runtime`; it contains no fork behavior and preserves the Host projection cut needed by browser-local unread state.
- The fork UI package never imports a private file from an upstream client package.
- The default upstream Web bundle contains no fork row and passes its own built proof.

---

## File Structure

- `packages/client/ui-workspace/src/client/contract/contributions.ts`: general row/badge/filter/sort contribution types.
- `packages/client/ui-workspace/src/client/contributions.ts`: effect-owned registry and snapshot source.
- `packages/client/ui-workspace/src/client/rows/Rows.tsx`: generic row render sites only.
- `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`: generic filter tabs and policy application only.
- `packages/fork/ui-workspace-overlay/`: all fork workspace behavior and presentation.
- `packages/bundle/fork-web/`: composition layer adding fork-base and browser plugin rows.
- `scripts/verify-web-composition.ts`: clean built-artifact CSS/bootstrap/plugin-roster verifier.
- `apps/web/tests/fork-web-smoke.snapshot.ts`: assembled browser interaction proof.

### Task 1: Establish the complete upstream client baseline

**Files:**
- Replace from merge parent: `packages/client/`
- Replace from merge parent when upstream-owned: client entries in `packages/bundle/web-app/cordis.patch.yml`.
- Modify: `.fork/migration/upstream-merge.md`

**Interfaces:**
- Produces a client tree identical to the selected upstream parent before fork client packages are added.

- [ ] **Step 1: Resolve and record the upstream merge parent**

```bash
UPSTREAM_PARENT=$(tr -d '\n' < .fork/migration/upstream-commit)
git rev-parse "$UPSTREAM_PARENT"
git diff --name-status "$UPSTREAM_PARENT" -- packages/client
```

Record the SHA and pre-reset client diff count in `.fork/migration/upstream-merge.md`.

- [ ] **Step 2: Restore upstream-owned client paths**

Use Git's path restore from the exact parent:

```bash
git restore --source="$UPSTREAM_PARENT" --staged --worktree -- packages/client packages/bundle/web-app/cordis.patch.yml
```

Delete a legacy client package only when `git cat-file -e "$UPSTREAM_PARENT:packages/client/ui-session-mode/package.json"` proves the package does not exist upstream and Plan 3 replaces or retires it. In particular, delete legacy `packages/client/ui-session-mode/`; Codex mode selection is deferred.

- [ ] **Step 3: Prove the baseline**

```bash
git diff --quiet "$UPSTREAM_PARENT" -- packages/client
```

Expected: exit `0` before `packages/fork/ui-workspace-overlay` or extension patches are added.

- [ ] **Step 4: Reinstall and run upstream client smoke**

Run: `pnpm install --lockfile-only`

Run: `pnpm run typecheck:contracts-ready`

Run: `pnpm exec vitest run packages/client/ui-slots packages/client/runtime packages/client/ui-workspace packages/client/ui-conversation`

Expected: PASS on the upstream baseline. A failure caused by Host migration is fixed at the API/package interface, not by restoring old client internals.

- [ ] **Step 5: Commit the baseline**

```bash
git add -A packages/client packages/bundle/web-app/cordis.patch.yml tsconfig.client.json pnpm-lock.yaml .fork/migration/upstream-merge.md
git commit -m "refactor(client): restore upstream baseline"
```

### Task 2: Add general workspace contribution points

**Files:**
- Create: `packages/client/ui-workspace/src/client/contract/contributions.ts`
- Create: `packages/client/ui-workspace/src/client/contributions.ts`
- Modify: `packages/client/ui-workspace/src/client/contract/slots.ts`
- Modify: `packages/client/ui-workspace/src/client/index.ts`
- Modify: `packages/client/ui-workspace/src/client/rows/Rows.tsx`
- Modify: `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`
- Test: `packages/client/ui-workspace/tests/contributions.client.spec.tsx`
- Modify paired package README files.

**Interfaces:**
- Produces Client service `ctx.workspaceContributions`.

```ts
export interface WorkspaceSessionRowContext {
  readonly session: SessionSummary
  readonly workspace: WorkspaceView
  readonly selected: boolean
}

export interface WorkspaceListView {
  readonly id: string
  readonly order: number
  readonly label: string
  include(context: WorkspaceSessionRowContext): boolean
}

export interface WorkspaceListPolicy {
  readonly id: string
  readonly order: number
  compare(left: WorkspaceSessionRowContext, right: WorkspaceSessionRowContext): number
}

export interface WorkspaceContributions {
  registerView(view: WorkspaceListView): () => void
  registerPolicy(policy: WorkspaceListPolicy): () => void
  readonly views: HostObservable<readonly WorkspaceListView[]>
  readonly policies: HostObservable<readonly WorkspaceListPolicy[]>
}
```

Add slots:

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'workspace.session-row.badges': { kind: 'list'; scope: 'root'; owner: WorkspaceSessionRowContext }
    'workspace.session-row.actions': { kind: 'list'; scope: 'root'; owner: WorkspaceSessionRowContext }
  }
}
```

- [ ] **Step 1: Write failing empty/contributed-path tests**

Prove zero registrations preserve the upstream DOM snapshot and ordering. Register one view, one global ordering policy, one badge, and one action; prove views and policies order by `(order, id)`, duplicate ids fail within their registry, unregister restores the empty path, and a throwing predicate/comparator produces a surfaced plugin error rather than silently dropping a session.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run packages/client/ui-workspace/tests/contributions.client.spec.tsx`

Expected: FAIL because the registry and slots do not exist.

- [ ] **Step 3: Implement the extension patch**

Own the registry in ui-workspace because it controls list semantics. Register the service through the plugin's Cordis context and every entry through effects. `WorkspaceBrowser` keeps its upstream default view as an internal non-removable fallback, renders contributed view tabs only when at least one exists, and applies every registered ordering policy after the active view filter so policies also affect the fallback view. `Rows` calls the two new render sites but contains no fork id, copy, pin, source, unread, or background condition.

- [ ] **Step 4: Run focused client tests and budget check**

Run: `pnpm exec vitest run packages/client/ui-workspace`

Run:

```bash
git diff --numstat "$UPSTREAM_PARENT" -- packages/client/ui-workspace
```

Expected: no more than 6 changed source files and 260 changed lines for the extension patch. If the budget is exceeded, split presentation into the fork package rather than raise the budget.

- [ ] **Step 5: Commit**

```bash
git add packages/client/ui-workspace
git commit -m "feat(ui-workspace): add list contribution points"
```

### Task 3: Implement the fork workspace UI plugin

**Files:**
- Create: `packages/fork/ui-workspace-overlay/package.json`
- Create: `packages/fork/ui-workspace-overlay/src/index.ts`
- Create: `packages/fork/ui-workspace-overlay/src/client/index.ts`
- Create: `packages/fork/ui-workspace-overlay/src/client/store.ts`
- Create: `packages/fork/ui-workspace-overlay/src/client/WorkspaceRowActions.tsx`
- Create: `packages/fork/ui-workspace-overlay/src/client/WorkspaceRowBadges.tsx`
- Create: `packages/fork/ui-workspace-overlay/src/client/BackgroundView.tsx`
- Create: `packages/fork/ui-workspace-overlay/src/client/workspace-overlay.module.css`
- Create: `packages/fork/ui-workspace-overlay/src/client/locales.ts`
- Create: `packages/fork/ui-workspace-overlay/tests/workspace-overlay.client.spec.tsx`
- Create: `packages/fork/ui-workspace-overlay/README.md`
- Create paired README translation files.

**Interfaces:**
- Consumes `ctx.workspaceContributions`, `ctx.slots`, `ctx.remote.forkWorkspaceSessionState`, session summaries/projections, and browser clipboard.
- Produces the `Background` view and entries in the two workspace row slots.

- [ ] **Step 1: Write failing behavior tests**

Cover these behaviors in one assembled client fixture:

- Copy Session ID writes the exact opaque id and reports clipboard rejection accessibly.
- Mark unread sets a browser-local read watermark below the session's current last sequence; opening the session advances it again.
- Background includes live/running sessions and sessions whose `forkSessionSource` is `github-actions`, without moving ordinary idle sessions.
- GitHub Actions badge renders only for the projection value `github-actions`.
- Pin/unpin calls the Typert Remote with the observed revision; stale revision refetches once and requires a second explicit click rather than replaying the mutation.
- Pinned sessions sort before unpinned sessions inside their workspace while preserving upstream order within each partition.
- Disposing the plugin removes its view, badges, actions, subscriptions, and locale namespace.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run packages/fork/ui-workspace-overlay/tests/workspace-overlay.client.spec.tsx`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Implement the store and contributions**

Keep server pins and client read watermarks separate. Persist read watermarks under one versioned `localStorage` key, `dsh.fork.workspaceReadWatermarks.v1`, with strict parsing and a safe empty fallback for malformed browser-local data. Do not write pin state optimistically before Host acceptance.

Register `Background` with id `fork.background` and order `100`. Register pin ordering policy `fork.pinned-first` with order `100`; it partitions pinned before unpinned and returns `0` inside each partition so upstream order is stable. Register row action ids `fork.copy-session-id`, `fork.mark-unread`, and `fork.pin-session`. Register one badge entry `fork.github-actions-source`. Use upstream primitives and theme tokens; no global CSS selector is allowed.

- [ ] **Step 4: Run package and cross-package tests**

Run: `pnpm exec vitest run packages/fork/ui-workspace-overlay packages/client/ui-workspace packages/fork/workspace-session-state packages/fork/session-source`

Run: `pnpm run typecheck:contracts-ready`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fork/ui-workspace-overlay packages/README.md tsconfig.client.json pnpm-lock.yaml
git commit -m "feat(fork): add workspace UI overlay"
```

### Task 4: Compose a separate fork Web bundle

**Files:**
- Create: `packages/bundle/fork-web/package.json`
- Create: `packages/bundle/fork-web/cordis.patch.yml`
- Create: `packages/bundle/fork-web/src/index.ts`
- Create: `packages/bundle/fork-web/src/invariant.ts`
- Create: `packages/bundle/fork-web/tests/fork-web.spec.ts`
- Create: `packages/bundle/fork-web/README.md`
- Create paired README translation files.
- Modify: `packages/boot/app-boot/src/profile.ts`
- Test: `packages/boot/app-boot/tests/profile.spec.ts`

**Interfaces:**
- Produces profile `fork-web` layering upstream `base`, upstream `web-app`, `fork-base`, and `fork-web` in that order.
- Adds one bounded product patch to the shipped profile template table: at most 2 upstream files and 40 changed lines.

- [ ] **Step 1: Write failing composition tests**

Assert the dumped `web` profile contains no `fork-*` row. Assert `fork-web` contains exactly one row each for session-source, workspace-session-state, first-chunk-timeout, and ui-workspace-overlay. Assert `ui-theme`, `client-runtime`, `ui-conversation`, and `ui-workspace` still resolve to the upstream package names.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run packages/bundle/fork-web/tests/fork-web.spec.ts`

Expected: FAIL because the bundle/profile is absent.

- [ ] **Step 3: Implement bundle/profile composition**

The fork Web patch uses `insert` only for `ui-workspace-overlay`. Host fork rows remain owned by `fork-base`. Package metadata lists the upstream bundles as dependencies; no source import reaches their private files. Add `fork-web` to `PROFILE_TEMPLATES` as `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-fork-base', '@deepseek-ai/dsh-fork-web']` and prove no existing template changes.

- [ ] **Step 4: Run configuration and clean-build gates**

Run: `pnpm run verify-cordis-config`

Run: `pnpm run verify-client-packages`

Run: `pnpm run build:official`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bundle/fork-web packages/boot/app-boot/src/profile.ts packages/boot/app-boot/tests/profile.spec.ts packages/README.md pnpm-lock.yaml
git commit -m "feat(fork): compose fork web profile"
```

### Task 5: Verify CSS, bootstrap, and plugin rosters from clean artifacts

**Files:**
- Create: `scripts/web-composition/types.ts`
- Create: `scripts/web-composition/inspect.ts`
- Create: `scripts/verify-web-composition.ts`
- Test: `scripts/web-composition/inspect.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `pnpm run verify-web-composition -- --profile web|fork-web`.

```ts
export interface WebCompositionEvidence {
  readonly profile: 'web' | 'fork-web'
  readonly cssFiles: readonly string[]
  readonly bootstrapModule: string
  readonly pluginIds: readonly string[]
  readonly themePluginId: string
}
```

- [ ] **Step 1: Write failing artifact tests**

Use fixture dist directories to reject zero CSS assets, a missing bootstrap script, absent `ui-theme`, duplicate plugin ids, missing upstream UI ids, and a fork profile without `ui-workspace-overlay`. Prove the upstream profile rejects any fork id.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run scripts/web-composition/inspect.spec.ts`

Expected: FAIL because the inspector is absent.

- [ ] **Step 3: Implement the inspector and scripts**

Read built HTML and emitted boot metadata; do not search source text as proof. Add:

```json
"verify-web-composition": "tsx scripts/verify-web-composition.ts"
```

The verifier runs the profile-specific clean build in a temporary output directory, inspects it, and removes only that validated temporary directory on exit.

- [ ] **Step 4: Run both compositions**

Run: `pnpm run verify-web-composition -- --profile web`

Run: `pnpm run verify-web-composition -- --profile fork-web`

Expected: PASS with CSS count, bootstrap module, theme id, and sorted plugin ids printed for each profile.

- [ ] **Step 5: Commit**

```bash
git add scripts/web-composition scripts/verify-web-composition.ts package.json
git commit -m "test(web): verify assembled compositions"
```

### Task 6: Add the built browser smoke

**Files:**
- Create: `apps/web/tests/fork-web-smoke.snapshot.ts`
- Modify: `vitest.web.config.ts` or the existing Web snapshot fixture registry only where required to select `fork-web`.
- Modify: `.fork/features.yaml`

**Interfaces:**
- Consumes the real built plugin roster and fixture Host transport.
- Proves session input and settings/menu interaction for both profiles.

- [ ] **Step 1: Write the failing browser smoke**

For `web`, boot the built application, create/open a session, type `hello`, submit through the normal composer, open Settings, and assert zero captured `window.error` or `console.error` records. For `fork-web`, repeat the flow, open the session row menu, copy the id, pin it, open Background, and assert the GitHub Actions badge fixture.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm run test:web:built -- apps/web/tests/fork-web-smoke.snapshot.ts`

Expected: FAIL until the built fixture can select the fork profile.

- [ ] **Step 3: Wire the profile selector without source aliases**

Select the profile through the same built plugin metadata path used in production. Do not add Vite aliases to source packages and do not import client source from the test.

- [ ] **Step 4: Run complete Web evidence**

Run: `pnpm run verify-web-composition -- --profile web`

Run: `pnpm run verify-web-composition -- --profile fork-web`

Run: `pnpm run test:web:built -- apps/web/tests/fork-web-smoke.snapshot.ts`

Run: `pnpm run website:build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/fork-web-smoke.snapshot.ts vitest.web.config.ts .fork/features.yaml
git commit -m "test(web): prove fork overlay interaction"
```

## Plan 3 Acceptance

- `git diff "$(tr -d '\n' < .fork/migration/upstream-commit)" -- packages/client` contains the bounded ui-workspace extension patch plus the one generic projection-watermark seam described above; fork client behavior lives under `packages/fork/`.
- Legacy `ui-session-mode` and all Codex transcript UI are absent.
- Upstream `web` has no fork plugin and passes CSS/bootstrap/input/settings evidence.
- `fork-web` adds the fork roster and passes the same evidence plus workspace actions.
- No fork source imports private upstream files or replaces InputBar, conversation shell, theme, client runtime, or upstream Web composition.
