# Upstream migration merge checkpoint

## Immutable baseline

- START_SHA: `a38d96793e6a11a6de61a158233aade6c45bf6ca`
- Recovery tag: `fork-overlay-recovery-2026-08-22`; target: `a38d96793e6a11a6de61a158233aade6c45bf6ca`
- Selected upstream SHA: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Exact merge command: `git merge --no-commit --no-ff upstream/master`
- Merge-side preference: none.
- The merge begins from a clean worktree at START_SHA. The captured post-merge status contains 2,409 status entries; 182 entries are unmerged below. All other entries are automatically merged upstream changes and remain in the staged merge result.

## Captured pre-resolution status and conflict inventory

The following is the complete unmerged portion of the captured `git status --short` output immediately after the normal merge. The two-letter status is the status recorded before any conflict resolution.

```text
UU .agents/notes/implemented/architecture/2026-08-15-client-shells-and-dynamic-packages.i18n.yaml
UU .github/workflows/ci.yml
UU README.i18n.yaml
UU apps/web/tests/assembled-boot.ts
UU docs/architecture.i18n.yaml
UU docs/architecture.zh.md
UU docs/config-catalog.i18n.yaml
UU docs/config-catalog.md
UU docs/config-catalog.zh.md
UU docs/development.i18n.yaml
UU docs/development.zh.md
UU docs/event-producer-consumer.i18n.yaml
UU docs/event-producer-consumer.md
UU docs/event-producer-consumer.zh.md
UU docs/i18n/README.i18n.yaml
UU docs/module-graph.i18n.yaml
UU docs/module-graph.md
UU docs/module-graph.zh.md
UU docs/persistence-catalog.i18n.yaml
UU docs/persistence-catalog.zh.md
UU docs/subsystems/README.i18n.yaml
UU docs/subsystems/README.zh.md
UU docs/subsystems/attachment.i18n.yaml
UU docs/subsystems/attachment.md
UU docs/subsystems/attachment.zh.md
UU docs/subsystems/client-modules.i18n.yaml
UU docs/subsystems/client-modules.md
UU docs/subsystems/client-modules.zh.md
UU docs/subsystems/commands.i18n.yaml
UU docs/subsystems/commands.md
UU docs/subsystems/commands.zh.md
UU docs/subsystems/llm-streaming.i18n.yaml
UU docs/subsystems/llm-streaming.zh.md
UU docs/subsystems/persistence.i18n.yaml
UU docs/subsystems/persistence.zh.md
UU docs/subsystems/plan.i18n.yaml
UU docs/subsystems/plan.md
UU docs/subsystems/plan.zh.md
UU docs/subsystems/session-reference.i18n.yaml
UU docs/subsystems/session-reference.md
UU docs/subsystems/session-reference.zh.md
UU docs/subsystems/session.i18n.yaml
UU docs/subsystems/subagent.i18n.yaml
UU docs/subsystems/web.i18n.yaml
UU docs/tool-catalog.i18n.yaml
UU docs/tool-catalog.zh.md
UU docs/user/guide/providers.i18n.yaml
UU docs/user/guide/providers.zh.md
UU examples/acp-agent/image.cordis.yml
UU examples/acp-agent/tests/acp.snapshot.ts
UU examples/acp-agent/tests/goal-snapshots/goal-round-driver/session.expected.jsonl
UU examples/acp-agent/tests/snapshots/cancel/session.jsonl
UU examples/acp-agent/tests/snapshots/code-mode-read-image/session.jsonl
UU examples/acp-agent/tests/snapshots/inline-image-prompt/session.jsonl
UU examples/acp-agent/tests/snapshots/read-image/session.jsonl
UU examples/acp-agent/tests/snapshots/skill-load/session.jsonl
UU packages/README.i18n.yaml
UU packages/api/remotes/package.json
UU packages/bundle/web-app/README.i18n.yaml
UU packages/bundle/web-app/README.zh.md
UU packages/bundle/web-app/package.json
UU packages/client/README.i18n.yaml
UU packages/client/README.zh.md
UU packages/client/connection/package.json
UU packages/client/hmr/package.json
UU packages/client/locale/README.i18n.yaml
UU packages/client/locale/README.zh.md
UU packages/client/locale/package.json
UU packages/client/modules/package.json
UU packages/client/modules/src/index.ts
UU packages/client/modules/tests/node-half.client.spec.ts
UU packages/client/runtime/README.i18n.yaml
UU packages/client/runtime/README.zh.md
UU packages/client/runtime/package.json
UU packages/client/ui-agent-preset/package.json
UU packages/client/ui-attachment/package.json
DU packages/client/ui-brand-official/package.json
UU packages/client/ui-commands/README.i18n.yaml
UU packages/client/ui-commands/package.json
UU packages/client/ui-conversation/README.i18n.yaml
UU packages/client/ui-conversation/README.md
UU packages/client/ui-conversation/README.zh.md
UU packages/client/ui-conversation/package.json
UU packages/client/ui-conversation/src/client/index.ts
UU packages/client/ui-conversation/src/client/skeleton/InputBar.tsx
UU packages/client/ui-conversation/tests/input-bar.client.spec.tsx
UU packages/client/ui-deliverables/package.json
UU packages/client/ui-directory-picker-browse/package.json
UU packages/client/ui-directory-picker-native/package.json
UU packages/client/ui-goal/package.json
UU packages/client/ui-input-trigger/package.json
UU packages/client/ui-jobs/package.json
UU packages/client/ui-layout/package.json
UU packages/client/ui-message-feedback/package.json
UU packages/client/ui-model-selection/package.json
UU packages/client/ui-permission-presets/package.json
UU packages/client/ui-plan/package.json
UU packages/client/ui-primitives/README.i18n.yaml
UU packages/client/ui-primitives/README.zh.md
UU packages/client/ui-primitives/package.json
DU packages/client/ui-reference/package.json
DU packages/client/ui-renderer/README.zh.md
UU packages/client/ui-session-mode/package.json
UU packages/client/ui-settings-general/package.json
UU packages/client/ui-settings-models/README.i18n.yaml
UU packages/client/ui-settings-models/package.json
UU packages/client/ui-settings-models/src/client/index.ts
UU packages/client/ui-settings-plugin-inventory/package.json
UU packages/client/ui-settings-plugins/package.json
UU packages/client/ui-settings/package.json
UU packages/client/ui-sidebar/README.i18n.yaml
UU packages/client/ui-sidebar/README.zh.md
UU packages/client/ui-sidebar/package.json
UU packages/client/ui-skill/package.json
UU packages/client/ui-slots/README.i18n.yaml
UU packages/client/ui-slots/README.zh.md
UU packages/client/ui-slots/package.json
UU packages/client/ui-subagent/package.json
UU packages/client/ui-subagent/src/client/index.ts
UU packages/client/ui-theme/README.i18n.yaml
UU packages/client/ui-theme/package.json
UU packages/client/ui-tool/README.i18n.yaml
UU packages/client/ui-tool/package.json
UU packages/client/ui-trajectory/package.json
UU packages/client/ui-user-questions/package.json
UU packages/client/ui-workflow-run/README.i18n.yaml
UU packages/client/ui-workflow-run/package.json
UU packages/client/ui-workspace/README.i18n.yaml
UU packages/client/ui-workspace/README.zh.md
UU packages/client/ui-workspace/package.json
UU packages/client/web-react/README.i18n.yaml
UU packages/client/web/README.i18n.yaml
UU packages/client/web/README.zh.md
UU packages/client/web/package.json
DU packages/client/web/src/boot.ts
UU packages/compaction/compaction-basic/README.i18n.yaml
UU packages/compaction/compaction-basic/README.zh.md
UU packages/core/agent-loop/README.i18n.yaml
UU packages/core/agent-loop/README.zh.md
UU packages/core/agent-loop/package.json
UU packages/core/session/README.i18n.yaml
UU packages/core/session/package.json
UU packages/host/apiproxy/README.i18n.yaml
UU packages/host/apiproxy/README.md
UU packages/host/apiproxy/README.zh.md
UU packages/host/apiproxy/package.json
UU packages/interaction/README.i18n.yaml
UU packages/interaction/README.zh.md
UU packages/llm/llm-deepseek/README.i18n.yaml
UU packages/llm/llm-deepseek/README.md
UU packages/llm/llm-deepseek/README.zh.md
UU packages/llm/llm-deepseek/package.json
UU packages/llm/llm-deepseek/src/adapter.ts
UU packages/llm/llm-deepseek/src/index.ts
UU packages/llm/llm-deepseek/src/serialize.ts
UU packages/llm/llm-deepseek/src/types.ts
UU packages/llm/llm-deepseek/tests/adapter.spec.ts
UU packages/llm/llm-deepseek/tests/dynamic-config.spec.ts
UU packages/llm/llm-deepseek/tests/serialize.spec.ts
UU packages/llm/llm-pi-ai/README.i18n.yaml
UU packages/llm/llm-pi-ai/README.md
UU packages/llm/llm-pi-ai/README.zh.md
UU packages/llm/llm-pi-ai/package.json
UU packages/llm/llm-pi-ai/src/adapter.ts
UU packages/llm/llm-pi-ai/src/config.ts
UU packages/llm/llm-pi-ai/src/context.ts
UU packages/llm/llm-pi-ai/tests/adapter.spec.ts
UU packages/llm/llm-pi-ai/tests/context.spec.ts
UU packages/llm/llm-retry/package.json
UU packages/llm/llm/README.i18n.yaml
UU packages/llm/llm/package.json
UU packages/llm/llm/src/content.ts
DU packages/llm/llm/tests/content.spec.ts
UU packages/session/session-persistence-sqlite/package.json
UU packages/subagent/tool-subagent/README.i18n.yaml
UU packages/test-support/client-runtime/package.json
UU pnpm-lock.yaml
DU scripts/client-build-environment.client.spec.ts
UU scripts/coverage-partitions.spec.ts
UU scripts/coverage-partitions.ts
UU tsconfig.base.json
UU tsconfig.host.json
```

The six `DU` entries are modify/delete conflicts: `packages/client/ui-brand-official/package.json`, `packages/client/ui-reference/package.json`, `packages/client/ui-renderer/README.zh.md`, `packages/client/web/src/boot.ts`, `packages/llm/llm/tests/content.spec.ts`, and `scripts/client-build-environment.client.spec.ts`. The other 176 entries are `UU`.

## Ownership resolutions

- Translation sidecars and generated documentation use the owning English/Chinese document bytes as their source of truth. The repository translation-pairing resolver stages mechanically composable records; the remaining records are regenerated from the manually resolved owner documents. No unrelated product behavior is added.
- Documentation, workflow, ACP fixture, and snapshot conflicts retain the upstream hunk structure. Snapshot and catalog outputs remain at this structural checkpoint; behavior-level acceptance remains with their owning later checks.
- Host and capability package conflicts retain upstream package structure and upstream additions. Package metadata and source conflicts are resolved at conflict hunks, preserving surrounding merged context. The owning package READMEs under `packages/client`, `packages/host/apiproxy`, `packages/llm`, `packages/core`, `packages/compaction`, `packages/interaction`, `packages/api`, and `packages/bundle` were reviewed against the upstream release commit.
- Client conflicts are resolved at individual conflict hunks to upstream structure; no client subtree or package is copied wholesale. Client paths remain deliberately unaccepted at this checkpoint: the six modify/delete paths and their dependent client split are Plan 3 Task 1 acceptance work, so this merge records the upstream parent without asserting client readiness. The fork-owned `packages/client/ui-session-mode/package.json` collision retains its existing path-owned metadata so Plan 3 can install the complete upstream `ui-brand-official`, `ui-reference`, and `ui-renderer` split without an invalid package identity at this checkpoint.
- The Host package fix round restores `packages/session/session-persistence-sqlite/` to the selected upstream 75-path inventory through an explicit per-path patch. Every worktree file hash matches `upstream/master`, and the feature inventory assigns no fork behavior to this package.
- The Host baseline fix round restores the eleven assigned roots to the selected upstream tree through an explicit per-path patch. It removes not-yet-migrated provider timeout, compaction, subagent, session-header, source, workspace, and external-session wiring from upstream-owned files; it does not delete fork-only package paths owned by Task 7.
- No Task 3–8 plugin, provider, consumer, composition bundle, product patch, or Codex runtime is implemented in this merge checkpoint. The future owner for the client split and UI acceptance is Plan 3.

## Post-merge fix round

- Merge checkpoint: `e15d7225b998b590ea99a5d77de3e2d71a4b1ff7`.
- Follow-up fix commit: `e6c7553ca950ceb5f7f2b87093c88c1eb963143d` (`fix(merge): restore upstream sqlite persistence and reasoning serialization`).
- The follow-up restores upstream reasoning-only `reasoning_content` propagation and the complete selected-upstream SQLite Host package. Its focused checks pass; repository-wide client and lockfile acceptance remain intentionally RED for Plan 3 Task 1.
- Host-baseline fix commit: `dbdbad7153e40ca4e5efe364e74b4ee321e36d0f` (`fix(merge): align Host roots with selected upstream`).
- The Host-baseline commit makes these roots byte-identical to selected upstream (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`): `packages/api/remotes/`, `packages/compaction/compaction-basic/`, `packages/core/agent-loop/`, `packages/core/session/`, `packages/host/apiproxy/`, `packages/llm/llm/`, `packages/llm/llm-deepseek/`, `packages/llm/llm-pi-ai/`, `packages/llm/llm-retry/`, `packages/session/session-persistence-sqlite/`, and `packages/subagent/tool-subagent/`.
- The client, client test support, upstream Web bundle, and lockfile remain deliberately unaccepted for Plan 3 Task 1. Fork-only external/Codex package paths and Agent Notes remain owned by Task 7. The frozen install remains RED because the unchanged lockfile still contains `@deepseek-ai/dsh-external-session` for the upstream-restored `packages/host/apiproxy/package.json`.
- Additional Host-baseline fix commit: `4a3d4013d0cfcbdcd6a5488d753cd16f8e134c60` (`fix(merge): align remaining Host roots with upstream`).
- The additional fix makes these six cleanly merged roots byte-identical to selected upstream: `packages/bundle/headless/`, `packages/core/agent/`, `packages/session/session-persistence-jsonl/`, `packages/test-support/llm-mock-server/`, `packages/util/timeout/`, and `packages/workspace/workspace/`.
- The clean-merge package audit compares every remaining differing `packages/**` path with selected upstream: 548 paths remain, all 548 belong to Plan 3 client/client-runtime/Web-app surfaces or Task 7 external, external-permission, group README, session-projection, and app-boot surfaces; zero paths are unassigned.
- Focused tests for the six additional roots pass (18 files, 485 tests); their package typecheck and targeted Oxlint pass. The broader Host typecheck and Oxlint remain limited by existing cross-package fork gaps recorded in the fix report.
- ACP example-baseline fix commit: `f7ab5919f1254c58fc630246d8a96c19eeedba9f` (`fix(merge): align ACP example with upstream`).
- The ACP example tree is byte-identical to selected upstream after the per-path fix. Its replay passes 90 of 93 tests with two skips; the single normal-environment failure is Node's SQLite `ExperimentalWarning` emitted on stderr, and the isolated scenario passes with `NODE_OPTIONS=--disable-warning=ExperimentalWarning`.
- The remaining Host typecheck errors have only two owners: Plan 3 client/client-runtime/Web-app and client build-script paths, or Task 7 external, external-permission, and session-projection paths. No unowned Host or example source error remains.

## Plan 3 Task 1 client baseline

- Upstream parent resolved from `.fork/migration/upstream-commit`: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.
- Pre-reset client diff: 466 path entries from `git diff --name-status "$UPSTREAM_PARENT" -- packages/client`.
- The upstream-owned `packages/client/` tree, Web-app patch/package metadata, client test-runtime support, assembled Web boot fixture, and `tsconfig.client.json` are restored to that parent. `tsconfig.base.json` keeps the Plan 2 fork aliases while migrating only the client aliases from `schema-form`/`web-react` to upstream `ui-renderer`, `ui-brand-official`, and `ui-reference`. Upstream does not contain `packages/client/ui-session-mode/package.json`; its tracked legacy package is removed, while Codex mode selection remains deferred.

## Merge-side preference

No merge-side preference is used. The merge invocation contains only `--no-commit --no-ff`; no side-selection option appears in the procedure or history.
