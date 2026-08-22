# Overlay Manifest and Verification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-plane verifier that classifies every fork diff against an immutable upstream commit and rejects overlap, stale entries, ownership collisions, whole-package claims, invalid verification targets, and patch-budget violations.

**Architecture:** A small typed core parses `.fork/overlay.yaml`, obtains immutable tree and numstat data through an injected Git reader, and returns deterministic diagnostics without mutating Git. The CLI supplies the real Git adapter. This first plan tests the complete verifier against fixture repositories but does not add it to `ci-static` until the migration has a complete manifest in Plan 4.

**Tech Stack:** TypeScript 6, Node `child_process.execFile`, `js-yaml`, Vitest, Git plumbing commands.

**Spec:** `docs/superpowers/specs/2026-08-22-plugin-first-fork-overlay-design.md`

## Global Constraints

- `upstream/master` is consumed directly; no mirror branch is introduced.
- Git remains the source of truth; the repository stores no duplicate patch files.
- Path coverage is exact or directory-tree coverage; glob syntax is forbidden.
- Every changed path must be covered by exactly one entry.
- Fork-owned paths must be absent from the recorded upstream tree.
- An extension or product patch may not claim an entire upstream package.
- The CLI is read-only and fails closed with exit code `1` for manifest or classification errors.
- The legacy repository-wide diff is not blessed by a temporary wildcard or compatibility class.

---

## File Structure

- `scripts/fork-overlay/types.ts`: public manifest, Git fact, and diagnostic types.
- `scripts/fork-overlay/manifest.ts`: strict YAML parsing and semantic validation.
- `scripts/fork-overlay/classify.ts`: path coverage and per-entry budget accounting.
- `scripts/fork-overlay/git-reader.ts`: read-only Git adapter.
- `scripts/fork-overlay/verify.ts`: repository-independent verification orchestration.
- `scripts/verify-fork-overlay.ts`: CLI and stable diagnostics.
- `scripts/fork-overlay/*.spec.ts`: parser, classification, verifier, and real temporary-repository tests.
- `.fork/README.md`: operator reference for the format and migration activation rule.
- `.agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.md`: design record, with its paired translation files.

### Task 1: Define and parse the manifest

**Files:**
- Create: `scripts/fork-overlay/types.ts`
- Create: `scripts/fork-overlay/manifest.ts`
- Test: `scripts/fork-overlay/manifest.spec.ts`

**Interfaces:**
- Consumes: YAML text and a manifest source name.
- Produces: `parseOverlayManifest(text: string, source: string): OverlayManifest`.

- [ ] **Step 1: Write the failing parser tests**

Cover one complete manifest plus duplicate ids, a non-40-hex upstream commit, an empty path list, `..`, absolute paths, glob metacharacters, a tree path without a trailing slash, an exact path with a trailing slash, patch entries without budgets, and fork-owned entries with budgets.

```ts
it('parses one entry of every class', () => {
  const manifest = parseOverlayManifest(validYaml, 'fixture.yaml')
  expect(manifest).toMatchObject({ schemaVersion: 1, upstreamCommit: 'a'.repeat(40) })
  expect(manifest.entries.map(entry => entry.kind)).toEqual([
    'fork-owned', 'composition', 'extension-patch', 'product-patch', 'workflow',
  ])
})

it.each(['../escape', '/absolute', 'packages/*/wild', 'packages/x?[y]'])('rejects unsafe path %s', path => {
  expect(() => parseOverlayManifest(yamlWithPath(path), 'fixture.yaml')).toThrow(/repository-relative path/)
})
```

- [ ] **Step 2: Run the parser tests and confirm RED**

Run: `pnpm exec vitest run scripts/fork-overlay/manifest.spec.ts`

Expected: FAIL because `parseOverlayManifest` does not exist.

- [ ] **Step 3: Implement the exact types and strict parser**

Use this public type vocabulary; do not add a legacy or catch-all kind.

```ts
export type OverlayKind =
  | 'fork-owned'
  | 'composition'
  | 'extension-patch'
  | 'product-patch'
  | 'workflow'

export interface OverlayPath {
  readonly path: string
  readonly coverage: 'exact' | 'tree'
}

export type VerificationTarget =
  | { readonly kind: 'script'; readonly name: string }
  | { readonly kind: 'vitest'; readonly files: readonly string[] }

export interface PatchBudget {
  readonly maxFiles: number
  readonly maxChangedLines: number
}

export interface OverlayEntry {
  readonly id: string
  readonly kind: OverlayKind
  readonly paths: readonly OverlayPath[]
  readonly owner: string
  readonly agentNote: string
  readonly verify: readonly VerificationTarget[]
  readonly retireWhen: string
  readonly budget?: PatchBudget
  readonly generatedBy?: string
}

export interface OverlayManifest {
  readonly schemaVersion: 1
  readonly upstreamCommit: string
  readonly entries: readonly OverlayEntry[]
}
```

Parse with `load(text, { schema: JSON_SCHEMA })`, reject unknown object keys at every level, require positive safe-integer budgets, normalize no values, and report errors as the source name followed by the parser message.

- [ ] **Step 4: Run parser tests and confirm GREEN**

Run: `pnpm exec vitest run scripts/fork-overlay/manifest.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit the parser**

```bash
git add scripts/fork-overlay/types.ts scripts/fork-overlay/manifest.ts scripts/fork-overlay/manifest.spec.ts
git commit -m "feat(fork): parse overlay manifest"
```

### Task 2: Classify Git changes exactly once

**Files:**
- Create: `scripts/fork-overlay/classify.ts`
- Test: `scripts/fork-overlay/classify.spec.ts`

**Interfaces:**
- Consumes: `OverlayManifest`, `readonly DiffEntry[]`, and `ReadonlySet<string>` of upstream paths.
- Produces: `classifyOverlay(input: ClassificationInput): ClassificationResult`.

- [ ] **Step 1: Write failing classification tests**

Use rename records with both old and new paths, deletions, overlapping exact/tree entries, stale entries, a fork-owned collision, a patch over budget, and a patch that claims `packages/client/ui-workspace/` as a tree.

```ts
it('requires both sides of a rename to have one owner', () => {
  const result = classifyOverlay(fixture({
    diffs: [{ status: 'R', oldPath: 'packages/a/old.ts', path: 'packages/a/new.ts', added: 3, removed: 2 }],
  }))
  expect(result.diagnostics.map(item => item.code)).toEqual(['uncovered-path'])
  expect(result.diagnostics[0]?.path).toBe('packages/a/old.ts')
})

it('rejects a fork-owned path that appears upstream', () => {
  const result = classifyOverlay(fixture({ upstreamPaths: new Set(['packages/fork/x/src/index.ts']) }))
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'fork-owned-collision' }))
})
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run scripts/fork-overlay/classify.spec.ts`

Expected: FAIL because the classifier does not exist.

- [ ] **Step 3: Implement coverage and budgets**

```ts
export interface DiffEntry {
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
  readonly path: string
  readonly oldPath?: string
  readonly added: number
  readonly removed: number
  readonly binary: boolean
}

export interface OverlayDiagnostic {
  readonly code:
    | 'uncovered-path' | 'overlapping-coverage' | 'stale-entry'
    | 'fork-owned-collision' | 'whole-package-patch' | 'budget-exceeded'
    | 'invalid-verification-target' | 'upstream-commit-missing'
  readonly message: string
  readonly entryId?: string
  readonly path?: string
}
```

An exact path matches only equality. A tree path matches `path.startsWith(entry.path)` and is valid only when the manifest path ends in `/`. Count a rename's old and new paths for ownership, but count its numstat once for budget. Binary changes count as one changed line so a binary patch cannot bypass the budget. A patch is a whole-package claim when tree coverage has exactly the three segments `packages`, package group, and package name.

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm exec vitest run scripts/fork-overlay/classify.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit the classifier**

```bash
git add scripts/fork-overlay/classify.ts scripts/fork-overlay/classify.spec.ts
git commit -m "feat(fork): classify overlay diff"
```

### Task 3: Add the read-only Git adapter and verification-target checks

**Files:**
- Create: `scripts/fork-overlay/git-reader.ts`
- Create: `scripts/fork-overlay/verify.ts`
- Test: `scripts/fork-overlay/git-reader.spec.ts`
- Test: `scripts/fork-overlay/verify.spec.ts`

**Interfaces:**
- Produces: `GitReader`, `createGitReader(root: string): GitReader`, and `verifyOverlay(input: VerifyOverlayInput): Promise<readonly OverlayDiagnostic[]>`.

- [ ] **Step 1: Write failing tests**

Create temporary Git repositories with `mkdtemp`, `git init`, explicit user identity, and two commits. Prove that spaces and rename records survive parsing, a missing commit yields `upstream-commit-missing`, a missing package script fails, and a missing Vitest file fails.

```ts
export interface GitReader {
  commitExists(commit: string): Promise<boolean>
  listTree(commit: string): Promise<ReadonlySet<string>>
  diff(commit: string): Promise<readonly DiffEntry[]>
}
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run scripts/fork-overlay/git-reader.spec.ts scripts/fork-overlay/verify.spec.ts`

Expected: FAIL because the Git adapter and verifier do not exist.

- [ ] **Step 3: Implement Git plumbing and target resolution**

Use `execFile('git', args, { cwd, encoding: 'buffer' })`; do not invoke a shell. Read tree paths with `git ls-tree -r -z --name-only` plus the `commit` argument. Read status and line totals as two NUL-safe calls, `git diff --name-status -z -M` plus `commit` and `--`, and `git diff --numstat -z -M` plus `commit` and `--`, then join by rename-aware path identity.

Load root `package.json` once. A script target is valid only when `scripts[name]` is a non-empty string. A Vitest target is valid only when every file is repository-relative, exists as a regular file, and ends in `.spec.ts`, `.spec.tsx`, `.e2e.ts`, or `.test.mjs`.

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm exec vitest run scripts/fork-overlay/git-reader.spec.ts scripts/fork-overlay/verify.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit the verifier core**

```bash
git add scripts/fork-overlay/git-reader.ts scripts/fork-overlay/verify.ts scripts/fork-overlay/git-reader.spec.ts scripts/fork-overlay/verify.spec.ts
git commit -m "feat(fork): verify overlay against git"
```

### Task 4: Ship the CLI and format reference without activating the legacy tree

**Files:**
- Create: `scripts/verify-fork-overlay.ts`
- Create: `.fork/README.md`
- Modify: `package.json`
- Test: `scripts/verify-fork-overlay.spec.ts`

**Interfaces:**
- Produces: `pnpm run verify-fork-overlay` and an optional `--manifest` path used by temporary-repository tests.

- [ ] **Step 1: Write the failing CLI tests**

Spawn the CLI against a valid fixture manifest and against a manifest with an uncovered path. Assert exit `0` plus `fork-overlay: PASS` for the first and exit `1` plus the stable line `UNCOVERED_PATH path=packages/upstream/file.ts: path is not covered by an overlay entry` for the second.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run scripts/verify-fork-overlay.spec.ts`

Expected: FAIL because the CLI does not exist.

- [ ] **Step 3: Implement the CLI and script**

The default manifest is `.fork/overlay.yaml`. Accept only zero arguments or `--manifest` followed by one repository-relative path. Sort diagnostics by code, entry id, then path. Add this root script:

```json
"verify-fork-overlay": "tsx scripts/verify-fork-overlay.ts"
```

Document every field and show a valid minimal example in `.fork/README.md`. State explicitly that `.fork/overlay.yaml` is created and the gate becomes required only at Plan 4 cutover; before that, CI must call the verifier only with fixture manifests.

- [ ] **Step 4: Run focused verification**

Run: `pnpm exec vitest run scripts/fork-overlay scripts/verify-fork-overlay.spec.ts`

Expected: PASS.

Run: `pnpm run typecheck:contracts-ready`

Expected: PASS.

- [ ] **Step 5: Commit the CLI**

```bash
git add .fork/README.md package.json scripts/verify-fork-overlay.ts scripts/verify-fork-overlay.spec.ts
git commit -m "feat(fork): add overlay verification command"
```

### Task 5: Record the architecture and close Plan 1

**Files:**
- Create: `.agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.md`
- Create: `.agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.zh.md`
- Create: `.agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.i18n.yaml`

**Interfaces:**
- Produces: the permanent Agent Note referenced by Plan 4 manifest entries.

- [ ] **Step 1: Write the Agent Note**

Record the four ownership classes, immutable upstream SHA, structured verification targets, exact/tree matching, rename handling, budget calculation, stale-entry failure, and why activation waits for the migrated tree. Do not cite this implementation plan or narrate the design session.

- [ ] **Step 2: Run the focused gates**

Run: `pnpm exec vitest run scripts/fork-overlay scripts/verify-fork-overlay.spec.ts`

Run: `pnpm run verify-agent-note-format`

Run: `pnpm run verify-translation-pairing`

Run: `git diff --check`

Expected: all commands PASS for tracked Plan 1 files. If repository-wide documentation gates report unrelated pre-existing untracked files, capture their exact paths and do not edit them.

- [ ] **Step 3: Commit the note**

```bash
git add .agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.md .agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.zh.md .agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.i18n.yaml
git commit -m "docs(notes): record fork overlay manifest"
```

## Plan 1 Acceptance

- The CLI test creates a temporary repository and proves `--manifest .fork/overlay.yaml` succeeds for a fully classified fixture.
- Every required failure mode has a deterministic test.
- The real legacy diff has not been hidden under a wildcard, temporary class, or oversized budget.
- No top-level CI aggregate requires `.fork/overlay.yaml` before Plan 4 creates a complete file.
