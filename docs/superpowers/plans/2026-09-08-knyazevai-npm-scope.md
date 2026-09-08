# KnyazevAI npm Scope Migration Implementation Plan

English | [中文](2026-09-08-knyazevai-npm-scope.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and run the complete DSH package family as `@knyazevai/dsh*`, while leaving the vendored Cordis packages under `@deepseek-ai` and preserving the compaction, timeout-recovery, and client-bundle fixes.

**Architecture:** A repository-owned, idempotent codemod rewrites the DSH package prefix in tracked current-state files and rejects later drift in check mode. Release-family validation owns the two allowed npm prefixes explicitly: DSH uses `@knyazevai/dsh`, while vendor packages retain `@deepseek-ai`. The migration is applied once in source, documented in an implemented Agent Note, versioned as `0.1.5`, and then verified from packed tarballs before publication.

**Tech Stack:** TypeScript ESM, Node.js `child_process` and `fs`, pnpm workspaces, Vitest, tsdown, GitHub Actions, npm.

**Spec:** `docs/superpowers/specs/2026-09-08-knyazevai-npm-scope-design.md`

## Global Constraints

- Rewrite only the package-name prefix `@deepseek-ai/dsh` to `@knyazevai/dsh`; do not change repository URLs or vendored `@deepseek-ai/cordis`, `@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`, or `@deepseek-ai/cordis-plugin-*` names.
- The codemod operates only on Git-tracked text files and excludes `vendor/`, `.agents/notes/`, `docs/superpowers/specs/`, `docs/superpowers/plans/`, generated build output, dependency trees, and its own source-prefix declaration.
- Active Agent Notes that own npm identity or publication are updated deliberately; archived Agent Notes remain byte-for-byte unchanged.
- Every DSH release member and private DSH workspace package uses the equivalent `@knyazevai/dsh*` name and shared version `0.1.5`.
- The CLI package name and installed release entry are exactly `@knyazevai/dsh`; the tag remains `dsh-v0.1.5`.
- The migration remains source-level and permanent; do not add aliases, wrappers, postinstall downloads, GitHub tarball dependencies, or artifact-only rewrites.
- Preserve the previously implemented 50% compaction threshold, forced first-chunk timeout compaction/continuation, and generated-client runtime import fix.
- Keep implementation minimal and report unrelated repository-wide baseline failures separately.

---

### Task 1: Deterministic DSH rescope command

**Files:**
- Create: `scripts/rescope-dsh.ts`
- Create: `scripts/rescope-dsh.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Git's tracked-file list from `git ls-files -z` and the repository root derived from `import.meta.dirname`.
- Produces: `eligibleDshRescopePath(path: string): boolean`, `rescopeDshText(text: string): string`, and CLI modes `--apply`, `--check`, or dry-run through `pnpm run rescope-dsh`.

- [ ] **Step 1: Write failing unit tests for path eligibility and literal replacement**

```ts
import { describe, expect, it } from 'vitest'
import { eligibleDshRescopePath, rescopeDshText } from './rescope-dsh.ts'

describe('DSH package rescope', () => {
  it('rewrites the DSH prefix without changing vendored package names or repository URLs', () => {
    expect(rescopeDshText(JSON.stringify({
      name: '@deepseek-ai/dsh-tool-bash',
      cordis: '@deepseek-ai/cordis',
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
    }))).toBe(JSON.stringify({
      name: '@knyazevai/dsh-tool-bash',
      cordis: '@deepseek-ai/cordis',
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
    }))
  })

  it('selects current tracked source and excludes historical or vendored records', () => {
    expect(eligibleDshRescopePath('packages/core/session/src/index.ts')).toBe(true)
    expect(eligibleDshRescopePath('vendor/cordis/package.json')).toBe(false)
    expect(eligibleDshRescopePath('.agents/notes/implemented/process/example.md')).toBe(false)
    expect(eligibleDshRescopePath('docs/superpowers/specs/example.md')).toBe(false)
    expect(eligibleDshRescopePath('scripts/rescope-dsh.ts')).toBe(false)
    expect(eligibleDshRescopePath('packages/core/session/lib/index.js')).toBe(false)
  })

  it('is idempotent', () => {
    const once = rescopeDshText("import '@deepseek-ai/dsh-session'")
    expect(rescopeDshText(once)).toBe(once)
  })
})
```

- [ ] **Step 2: Run the focused test and confirm it fails because the module does not exist**

Run: `pnpm exec vitest run scripts/rescope-dsh.spec.ts`

Expected: FAIL resolving `./rescope-dsh.ts`.

- [ ] **Step 3: Implement the minimal tracked-file codemod**

```ts
const SOURCE_PREFIX = '@deepseek-ai/dsh'
const TARGET_PREFIX = '@knyazevai/dsh'
const EXCLUDED_PREFIXES = [
  'vendor/',
  '.agents/notes/',
  'docs/superpowers/specs/',
  'docs/superpowers/plans/',
] as const
const EXCLUDED_SEGMENTS = ['/lib/', '/dist/', '/node_modules/'] as const
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonl', '.yml', '.yaml', '.md', '.py', '.snap',
])

export function rescopeDshText(text: string): string {
  return text.replaceAll(SOURCE_PREFIX, TARGET_PREFIX)
}
```

The CLI must parse only `--apply` and `--check`, reject an unknown option, read paths from `git ls-files -z`, and report every eligible file whose content would change. Dry-run exits successfully after reporting. `--apply` writes changed files and then proves a second pass has no changes. `--check` exits unsuccessfully when any eligible file still contains the source prefix. Read and write UTF-8 only for the listed text extensions.

- [ ] **Step 4: Add root scripts**

```json
"rescope-dsh": "tsx scripts/rescope-dsh.ts",
"rescope-dsh:check": "tsx scripts/rescope-dsh.ts --check"
```

- [ ] **Step 5: Run focused tests and CLI behavior checks**

Run: `pnpm exec vitest run scripts/rescope-dsh.spec.ts`

Expected: PASS.

Run: `pnpm run rescope-dsh`

Expected: exits zero, lists eligible files, and does not modify them.

Run: `pnpm run rescope-dsh:check`

Expected: exits nonzero and names stale eligible files before Task 2 applies the migration.

- [ ] **Step 6: Commit the command and tests**

```bash
git add package.json scripts/rescope-dsh.ts scripts/rescope-dsh.spec.ts
git commit -m "build: add deterministic dsh scope migration"
```

---

### Task 2: Apply package identity migration and enforce the split scopes

**Files:**
- Modify mechanically: every tracked file reported by `pnpm run rescope-dsh`.
- Modify deliberately: `scripts/release/families.ts`, `scripts/release/families.spec.ts`, `scripts/check-workspace-constraints.ts`, `scripts/publish-npm-baseline.ts`, `scripts/run-gates.ts`, `.github/workflows/release.yml`, `.github/workflows/release-publish.yml`, `AGENTS.md`, `docs/rescope.md`, and any generator or test whose remaining scope-wide assertion assumes every package starts with `@deepseek-ai/`.
- Create: `.agents/notes/implemented/process/2026-09-08-knyazevai-dsh-npm-scope.md`
- Create: `.agents/notes/implemented/process/2026-09-08-knyazevai-dsh-npm-scope.zh.md`
- Create: `.agents/notes/implemented/process/2026-09-08-knyazevai-dsh-npm-scope.i18n.yaml`
- Modify deliberately: `.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md`, `.agents/notes/implemented/process/2026-08-10-npm-release-sequences.zh.md`, `.agents/notes/implemented/process/2026-08-10-npm-release-sequences.i18n.yaml`, `.agents/notes/implemented/process/2026-09-03-npm-cli-resolution.md`, `.agents/notes/implemented/process/2026-09-03-npm-cli-resolution.zh.md`, `.agents/notes/implemented/process/2026-09-03-npm-cli-resolution.i18n.yaml`.
- Modify generated lock and pairing records: `pnpm-lock.yaml` and every `.i18n.yaml` counterpart for a mechanically changed bilingual document.

**Interfaces:**
- Consumes: Task 1's `pnpm run rescope-dsh -- --apply` and `pnpm run rescope-dsh:check` commands.
- Produces: DSH workspace names and references under `@knyazevai/dsh*`; `ReleaseFamily.packagePrefix: string`; release validation that independently accepts DSH and vendor scopes; a hygiene gate invoking `rescope-dsh:check`.

- [ ] **Step 1: Add failing release-family tests for separate npm scopes**

Update DSH fixtures and expectations to `@knyazevai/dsh*`, keep vendor fixtures under `@deepseek-ai/*`, and add these assertions:

```ts
expect(releaseFamily('dsh').installedEntry).toEqual({
  packageName: '@knyazevai/dsh',
  binPath: 'lib/bin.js',
})
expect(() => releaseFamily('dsh').members(dshFixtureRoot)).toThrow(/must name an @knyazevai\/dsh package/)
expect(() => releaseFamily('vendor').members(vendorFixtureRoot)).toThrow(/must name an @deepseek-ai package/)
```

Run: `pnpm exec vitest run scripts/release/families.spec.ts`

Expected: FAIL because the release base class still enforces one `@deepseek-ai/` prefix and the installed entry still uses the old CLI name.

- [ ] **Step 2: Give each release family its own package prefix**

```ts
export abstract class ReleaseFamily {
  abstract readonly packagePrefix: string

  members(root: string): ReleaseMember[] {
    // Existing discovery remains unchanged.
    if (!name.startsWith(this.packagePrefix)) {
      throw new Error(`${normalized} must name an ${this.packagePrefix} package`)
    }
  }
}

class DshFamily extends ReleaseFamily {
  readonly packagePrefix = '@knyazevai/dsh'
  readonly installedEntry = { packageName: '@knyazevai/dsh', binPath: 'lib/bin.js' }
}

class VendorFamily extends ReleaseFamily {
  readonly packagePrefix = '@deepseek-ai/'
}
```

Keep the root-package exclusion family-correct by changing its value to `@knyazevai/dsh-root`. Update baseline publication and workspace constraints to accept the explicit union `@knyazevai/dsh* | @deepseek-ai/<vendored-name>` instead of a broad accidental scope assumption.

- [ ] **Step 3: Apply the mechanical source migration**

Run: `pnpm run rescope-dsh -- --apply`

Expected: every reported tracked current-state file changes from the source DSH prefix to the target DSH prefix; `vendor/`, `.agents/notes/`, and migration documents do not change.

- [ ] **Step 4: Repair generated/current metadata after the rename**

Run: `pnpm install --lockfile-only`

Expected: the lockfile imports and workspace package identities use `@knyazevai/dsh*` while vendored resolutions remain under `@deepseek-ai`.

For each changed bilingual Markdown pair, update both sides mechanically and record the exact pair with `pnpm run verify-translation-pairing --write <english-path>`. Regenerate checked-in catalogs whose generators embed package names, then update their Chinese counterparts and pairing records by the documented generator workflow.

- [ ] **Step 5: Record the permanent fork-scope decision**

Create the new implemented process Agent Note with the required `Problem`, `Decision`, `Alternatives considered`, and `Consequences` sections. It must state that DSH publishes under `@knyazevai`, vendor packages stay under `@deepseek-ai`, the codemod is the upstream-sync replay mechanism, and aliases or artifact-only rewriting were rejected. Cross-link it from the two existing active notes and update their current command/package facts without rewriting archived notes.

Run: `pnpm run verify-translation-pairing --write .agents/notes/implemented/process/2026-09-08-knyazevai-dsh-npm-scope.md .agents/notes/implemented/process/2026-08-10-npm-release-sequences.md .agents/notes/implemented/process/2026-09-03-npm-cli-resolution.md`

Expected: all three named pairs are confirmed consistent.

- [ ] **Step 6: Add the drift check to the hygiene gate and test the migrated state**

Add `rescope-dsh:check` beside `rescope-vendor:check` in the hygiene gate's ordered command set.

Run: `pnpm run rescope-dsh:check`

Expected: PASS with no stale eligible DSH prefix.

Run: `pnpm exec vitest run scripts/rescope-dsh.spec.ts scripts/release/families.spec.ts scripts/check-workspace-constraints.spec.ts scripts/publish-npm-baseline.spec.ts`

Expected: PASS.

Run: `pnpm run constraints`

Expected: PASS for the split DSH/vendor scopes.

Run: `git diff --check`

Expected: PASS.

- [ ] **Step 7: Commit the source migration**

```bash
git add -A
git commit -m "build: move dsh packages to knyazevai scope"
```

---

### Task 3: Version 0.1.5 and prove the publishable artifacts

**Files:**
- Modify through the release command: `package.json`, every DSH family `package.json`, private DSH workspace manifests, and `pnpm-lock.yaml`.
- Verify without source changes: official build output and tarballs under the release command's temporary/output directories.

**Interfaces:**
- Consumes: Task 2's complete `@knyazevai/dsh*` source graph and existing `release:dsh`, `release:verify`, `release:pack`, and `release:verify-packed-install` commands.
- Produces: shared DSH version `0.1.5`, a release-ready commit, and local evidence that the packed CLI reports `0.1.5`.

- [ ] **Step 1: Verify the behavioral fixes before the release bump**

Run:

```bash
pnpm exec vitest run packages/compaction/compaction-basic/tests/compaction-basic.spec.ts packages/fork/llm-first-chunk-timeout/tests/timeout.spec.ts scripts/client-bundle-purity.spec.ts
```

Expected: PASS for the compaction threshold, timeout recovery, and generated-client import behavior.

Run:

```bash
pnpm exec vitest run --config vitest.snapshot.config.ts examples/headless-agent/tests/headless.snapshot.ts -t 'forces low-pressure first-chunk compaction'
```

Expected: PASS; the snapshot records forced compaction followed by continuation.

- [ ] **Step 2: Bump the complete DSH family to 0.1.5**

Run: `pnpm run release:dsh -- 0.1.5`

Expected: the command writes one shared `0.1.5` version to the root, publishable DSH members, private DSH packages, and lockfile, and creates its release commit.

- [ ] **Step 3: Build and verify the release family**

Run: `pnpm run build:official`

Expected: PASS and emit complete Host and Web artifacts.

Run: `pnpm run release:verify -- --family dsh`

Expected: PASS, with every DSH member named `@knyazevai/dsh*`, publishable, version `0.1.5`, and dependency-first order representable.

- [ ] **Step 4: Pack DSH and vendor dependencies, then install those exact bytes**

Use empty output directories and run the repository's release pack command once for family `dsh` and once for family `vendor`. Run `release:verify-packed-install` with both directories so npm resolves only the produced tarballs.

Expected: all tarballs pack; installation into an empty consumer succeeds; the packed `@knyazevai/dsh` executable reports `0.1.5`.

- [ ] **Step 5: Run final local release checks**

Run: `pnpm run typecheck`

Expected: PASS.

Run: `git diff --check`

Expected: PASS.

Run: `git status --short`

Expected: no uncommitted source changes; build and pack residue is ignored or removed only through the repository's safe cleanup path.

- [ ] **Step 6: Hand release evidence to the controller**

Report the exact commands and outcomes. The controller owns the external operations after whole-branch review: push the branch/commit, create `dsh-v0.1.5`, dispatch the protected publication workflow, wait for completion, and verify `npm view @knyazevai/dsh version` plus `npx @knyazevai/dsh@0.1.5 --version`.
