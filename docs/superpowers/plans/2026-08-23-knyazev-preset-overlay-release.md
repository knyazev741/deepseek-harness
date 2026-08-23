# Knyazev Preset Overlay Release Implementation Plan

English | [中文](2026-08-23-knyazev-preset-overlay-release.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `@knyazevai/dsh@0.1.4` as a backward-compatible provider overlay that also applies the bounded Knyazev compaction policy to the `standard` Agent Preset when the Host supports preset patch contributions, then publish the matching Harness fork.

**Architecture:** `AgentPresets` gains an effect-scoped, symbol-keyed registry for ordered patches targeting an existing preset. Contributions are deployment layers applied only while mounting that preset; stored preset files, user copies, session events, and child composition remain unchanged. The standalone package keeps its root provider/default-model patch and adds a runtime plugin that feature-detects this registry: current fork Hosts receive the compaction patch, while older official Hosts keep provider functionality and log that the optional preset patch was not installed.

**Tech Stack:** TypeScript, Cordis, `@deepseek-ai/cordis-plugin-include`, Vitest, YAML bundle patches, npm package exports, GitHub Actions.

**Spec:** [Plugin-first fork overlay roadmap](2026-08-22-plugin-first-fork-overlay-roadmap.md)

## Global Constraints

- Do not change or remove the Background UI contribution.
- Never commit `KNYAZEV_AI_API_KEY` values; configuration contains only the credential reference.
- Preserve `@knyazevai/dsh` provider installation on `@deepseek-ai/dsh@0.1.1-rc.2` even when preset patch contribution is unavailable.
- Apply compaction only to the `standard` Agent Preset; `minimal` and user-selected presets remain unchanged.
- User settings remain above composition defaults; the provider remains `knyazev-ai/deepseek-v4-flash` only when the user has not overridden it.
- Child agents continue using `AgentPresets.composeFrom()` and therefore join the parent's exact standing composition.
- Registrations use `ctx.effect()` and return a disposer; removing a contribution affects only mounts created afterward.
- Do not add a new Service Definition/Provider/Consumer capability seam: this is an extension of the existing `AgentPresets` registry.
- Merge `origin/master` into the fork with a normal merge and preserve both remote release coordination and local plugin-first behavior; never force-push.
- Publish npm only after assembled clean-install verification and independent review.

---

### Task 1: Integrate the live fork base

**Files:**
- Modify by semantic merge: `.github/`, `apps/cli/`, `apps/web/`, `packages/boot/app-boot/`, `scripts/client-build-environment*`, and synchronized Agent Note sidecars reported by `git merge origin/master`
- Test: `packages/boot/app-boot/tests/profile.spec.ts`
- Test: `apps/cli/tests/built-bin.e2e.ts`
- Test: `scripts/client-build-environment.spec.ts`
- Test: `scripts/client-build-environment.client.spec.ts`

**Interfaces:**
- Consumes: local plugin-first `master` and fetched `origin/master`.
- Produces: one merge commit containing remote coordinated profile release and shell-theme fixes without regressing `fork-web`.

- [ ] **Step 1: Reproduce the merge conflicts without changing `master`.**

Run `git merge --no-ff origin/master` only in `codex/knyazev-preset-release` and confirm the expected eight conflict paths.

- [ ] **Step 2: Resolve each conflict semantically.**

Keep the local dynamic UI-theme implementation, `boot.ts` aliases, `fork-web` profile tuple, localized `.zh.md` links, and positive/negative dynamic-theme tests. Add remote `initProfile()` execution for existing profiles, legacy workspace upgrade, and the exact `minimumReleaseAgeExclude` entry for `@knyazevai/dsh@0.1.3`. Re-record affected bilingual sidecars instead of hand-selecting hashes.

- [ ] **Step 3: Run focused merge evidence.**

Run the four owning test files, `pnpm run verify-translation-pairing`, and `git diff --check`; fix only merge-caused failures.

- [ ] **Step 4: Commit the resolved merge.**

Keep the Git-generated merge parentage and use the merge commit message that names `origin/master` integration.

### Task 2: Add Agent Preset patch contributions

**Files:**
- Create: `packages/preset/agent-presets/src/contributor.ts`
- Modify: `packages/preset/agent-presets/src/index.ts`
- Modify: `packages/preset/agent-presets/src/mount.ts`
- Modify: `packages/preset/agent-presets/package.json`
- Modify: `packages/preset/agent-presets/README.md`
- Modify: `packages/preset/agent-presets/README.zh.md`
- Modify: `packages/preset/agent-presets/README.i18n.yaml`
- Modify: `docs/architecture.md`
- Create or update: `.agents/notes/implemented/architecture/2026-08-23-agent-preset-patch-contributions.{md,zh.md,i18n.yaml}`
- Test: `packages/preset/agent-presets/tests/contributor.spec.ts`
- Test: `packages/preset/agent-presets/tests/mount.spec.ts`

**Interfaces:**
- Consumes: existing filesystem preset discovery and `Include.Config.patches`.
- Produces: `AGENT_PRESET_PATCH_CONTRIBUTOR`, `AgentPresetPatchContribution`, and an effect-scoped `register()` API exposed through the existing `AgentPresets` service.

- [ ] **Step 1: Write failing registry tests.**

Cover registration order, disposal, target isolation (`standard` changes while `minimal` does not), a missing target that fails only when resolved, and generation invalidation for later mounts. Assert that an already joined session and `composeFrom()` child keep their original standing generation.

- [ ] **Step 2: Verify RED.**

Run the new contributor test and confirm failure because the symbol-keyed registry and mounted patches do not exist.

- [ ] **Step 3: Implement the public contribution API.**

Use a documented `Symbol.for()` key so a JavaScript plugin can feature-detect the Host without importing a version-specific package. `register({ presetId, patches })` validates a non-empty preset id and non-empty patch list, stores an immutable copy in registration order, increments the target generation, and returns a disposer through `ctx.effect()` ownership.

- [ ] **Step 4: Apply patches at standing mount creation.**

Pass the target preset's flattened ordered patches into `PresetTree` through `Include.Config.patches`. Key standing generations by the composition file stamp plus contribution generation. Stored `read()` and `copy()` remain file operations and do not materialize deployment overlays; document that distinction.

- [ ] **Step 5: Verify GREEN and adjacent behavior.**

Run contributor, mount, authoring, session, and package invariant tests. Run scoped coverage for the new source and preserve per-file 100% thresholds.

- [ ] **Step 6: Document and commit.**

Update the package reference, architecture extension-point map, and bilingual Agent Note; re-record pairing records and commit code, tests, and docs together.

### Task 3: Build `@knyazevai/dsh@0.1.4`

**Files in `/private/tmp/knyazevai-dsh-v014`:**
- Modify: `cordis.patch.yml`
- Create: `src/agent-preset.js`
- Create: `test/agent-preset.test.js`
- Modify: `test/config.test.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.github/workflows/publish.yml`
- Create: `package-lock.json`

**Interfaces:**
- Consumes: the symbol key and registration object defined by Task 2.
- Produces: package export `@knyazevai/dsh/agent-preset`, root provider/default-model patch, and an optional `standard` preset compaction contribution.

- [ ] **Step 1: Write failing package tests.**

Assert exact portable provider defaults, ordered eight-code retry policy, absence of secret values and `reasoningEffort`, runtime registration when the symbol API exists, clean no-op plus warning when it does not, disposer behavior, and exact nested `compaction` patch targeting `compaction-basic`.

- [ ] **Step 2: Verify RED.**

Run `npm test` and confirm failure because the runtime entry and synchronized defaults do not exist.

- [ ] **Step 3: Implement the optional runtime plugin.**

Inject `agentPresets`, feature-detect the `Symbol.for()` contributor key, and register a patch for `standard`. The nested patch sets `maxSummarizationInputTokens: 0`, `compactionRetries: 2`, `maxOverflowRetries: 2`, plus three model policies capped at `131072`. On an old Host, warn once and leave provider functionality active.

- [ ] **Step 4: Synchronize provider defaults.**

Match `fork-base`: OpenAI Completions, Knyazev endpoint, 15/30 minute stream/request timeouts, 20 retries over all eight codes, Qwen thinking compatibility, `reasoning: high`, and the three exact model catalogs. Keep `agent-default-model` at DeepSeek V4 Flash. Remove ineffective root compaction and subagent rows.

- [ ] **Step 5: Repair release reproducibility.**

Generate and commit `package-lock.json`, replace the workflow's `npm ci || npm install` fallback with deterministic `npm ci`, update README claims and compatibility matrix, and keep `prepublishOnly: npm test` valid in the packed artifact.

- [ ] **Step 6: Verify and commit.**

Run `npm test`, `npm pack --dry-run`, install the tarball into both a mock old Host and the new Harness worktree, and commit the package release candidate without tagging.

### Task 4: Assembled acceptance and release

**Files:**
- Test/modify if required: `apps/cli/tests/built-bin.e2e.ts`
- Test/modify if required: `apps/cli/tests/web-agent-presets.e2e.ts`
- Modify only through versioning: `/private/tmp/knyazevai-dsh-v014/package.json`, `package-lock.json`

**Interfaces:**
- Consumes: Tasks 1-3 release candidates.
- Produces: verified npm `0.1.4`, GitHub plugin `main`/`v0.1.4`, and Harness fork `master`.

- [ ] **Step 1: Run assembled RED/GREEN proof.**

Install the plugin tarball with `dsh plugin --profile web add <tarball>` in a fresh `DSH_HOME`. Start built Web, create a standard-preset session through the real app path, and assert the mounted compaction service resolves the Knyazev policy. Assert `minimal` is unchanged and child composition joins the parent's standing generation.

- [ ] **Step 2: Run outgoing Harness evidence.**

Run focused preset/profile/CLI/client tests, `pnpm run build`, a full `pnpm run test` because the user requested full rehearsal, `pnpm run doc-sync`, relevant hygiene, and `git diff --check` against the fetched `origin/master` merge base.

- [ ] **Step 3: Run independent review.**

Review the full Harness merge/feature diff and the complete npm package diff. Fix every Critical or Important finding and re-review the fix only.

- [ ] **Step 4: Prepare npm publication.**

Set version `0.1.4`, verify `npm whoami`, packed contents, package provenance fields, and absence of secret literals. Publishing credentials may be used locally; copying an npm token into GitHub Actions requires explicit security approval.

- [ ] **Step 5: Publish and verify npm.**

Run `npm publish`, then verify `npm view @knyazevai/dsh@0.1.4 version dist gitHead` and repeat the exact official/fork install smoke from the public registry.

- [ ] **Step 6: Push without rewriting history.**

Push plugin `main` and `v0.1.4` explicitly to `github`; push Harness explicitly with `git push origin master`. Fetch both live refs and require their OIDs to equal local HEAD/tag targets. Do not use raw force or a bare `git push` from Harness `master`.
