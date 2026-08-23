# 安全上游同步与切换实施计划

[English](2026-08-22-safe-upstream-sync-cutover.md) | 中文

> **致智能体工作者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 子技能，逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 激活完整的 overlay manifest，将 fork 优先的同步替换为快速失败的候选工作流，证明冲突和 UI 失败模拟，并将经过评审的迁移合并到 `master`。

**架构：** 由仓库脚本而非工作流 prose 负责合并准备、上下文生成、报告验证和模拟。工作流从 `master` 创建候选分支，执行普通合并；存在冲突时，让配置好的仓库 agent 只编辑候选分支；验证其结构化 disposition report，然后运行 overlay 以及受影响产品的证据检查。第二个 agent 评审完成的候选分支。最终 cutover 在迁移 PR 可合并之前使用同一套脚本进行 dry run。

**技术栈：** TypeScript、Git plumbing、GitHub Actions、用于未来 CI 解决和评审的 DeepSeek Harness headless runner、Vitest 临时 Git fixture、`gh` CLI。

**规范：** `docs/superpowers/specs/2026-08-22-plugin-first-fork-overlay-design.md`

## 全局约束

- 候选分支是 `sync/upstream-master`；自动化永远不会直接写入 `master`。
- 只执行普通合并：不得使用 `-X ours`、`-X theirs`、checkout 侧解决、宽泛的工作流排除或不带 lease 的 force push。
- 缺少 resolver、resolver 报告无效、存在未解决冲突、门禁失败或 reviewer verdict 有风险时，PR 保持不可合并。
- resolver 和 reviewer 是拥有独立 prompt 和产物的分离 agent 运行。
- 工作流排除仅覆盖 manifest 中记录的两个 fork-owned 工作流文件。
- `.fork/overlay.yaml` 写入集成到候选分支的确切不可变上游 SHA。
- 在门禁加入 CI 之前，每个最终 tree 差异都必须恰好覆盖一次。
- 不引入部署步骤。

---

## 文件结构

- `.fork/overlay.yaml`：当前完整的所有权清单。
- `scripts/upstream-sync/types.ts`：上下文和报告类型。
- `scripts/upstream-sync/prepare.ts`：普通合并准备和冲突事实收集。
- `scripts/upstream-sync/context.ts`：基于仓库的 resolver/reviewer 输入。
- `scripts/upstream-sync/report.ts`：严格的 JSON 报告解析和 disposition 验证。
- `scripts/upstream-sync/finalize.ts`：未解决状态、manifest-SHA、生成输出和提交检查。
- `scripts/upstream-sync/simulate.spec.ts`：临时仓库合并和失败模拟。
- `scripts/run-gates.ts`：普通变更对 overlay 门禁的激活。
- `.github/review/upstream-resolver-task.md`：resolver 约定。
- `.github/review/upstream-reviewer-task.md`：独立 reviewer 约定。
- `.github/workflows/upstream-sync.yml`：仅创建候选分支。
- `.github/workflows/upstream-review.yml`：证据、独立评审和受保护的 PR 合并。

### 任务 1：创建当前完整的 overlay manifest

**文件：**
- 创建：`.fork/overlay.yaml`
- 修改：`.fork/README.md`
- 仅在验证器发现实际未覆盖的最终差异时修改 package、TypeScript 或生成文件。

**接口：**
- 消费 Plan 1 的验证器和 Plan 2 的确切上游合并父提交。
- 产出零诊断的 `pnpm run verify-fork-overlay` 结果。

- [ ] **步骤 1：设置不可变的上游提交**

```bash
UPSTREAM_PARENT=$(tr -d '\n' < .fork/migration/upstream-commit)
git cat-file -e "$UPSTREAM_PARENT^{commit}"
```

使用 `schemaVersion: 1` 和打印出的 SHA 创建 `.fork/overlay.yaml`。不要将 `upstream/master` 或其他移动 ref 写入文件。

- [ ] **步骤 2：添加 fork-owned 和 composition 条目**

当最终差异中存在以下确切 tree 和文件时，为其创建稳定条目：

| id | kind | path coverage |
|---|---|---|
| `fork-overlay-tooling` | `fork-owned` | `scripts/fork-overlay/`、`scripts/verify-fork-overlay.ts`、`.fork/overlay.yaml`、`.fork/README.md`、`.fork/features.yaml`、`.fork/migration/` |
| `fork-overlay-design` | `fork-owned` | 2026-08-22 spec、roadmap、四个 plan 文件、overlay-manifest Agent Note 对，以及 completed-migration Agent Note 对，按精确路径声明 |
| `fork-session-source` | `fork-owned` | `packages/fork/session-source/` |
| `fork-workspace-session-state` | `fork-owned` | `packages/fork/workspace-session-state/` |
| `fork-first-chunk-timeout` | `fork-owned` | `packages/fork/llm-first-chunk-timeout/` |
| `fork-external-session-seam` | `fork-owned` | `packages/fork/external-session/` |
| `fork-workspace-ui` | `fork-owned` | `packages/fork/ui-workspace-overlay/` |
| `fork-base-composition` | `composition` | `packages/bundle/fork-base/` |
| `fork-web-composition` | `composition` | `packages/bundle/fork-web/`、`examples/fork-web/` |
| `fork-web-evidence` | `fork-owned` | `scripts/web-composition/`、`scripts/verify-web-composition.ts`、确切的 fork Web smoke 文件 |
| `fork-upstream-sync` | `workflow` | 确切的两个 workflow 文件、两个 review prompt 文件、review settings 文件和 `scripts/upstream-sync/` |

每个条目都要写明确切的 Agent Note、验证目标、owner 和退出条件。不要用宽泛 tree 覆盖根 `package.json`、`pnpm-lock.yaml`、TypeScript face、package index 或生成 catalog；通过精确覆盖和 `generatedBy`，将每个文件列在触发它的 composition 条目下。

- [ ] **步骤 3：添加有界 patch 条目**

添加 `ui-workspace-contributions` 作为 `extension-patch`，包含 Plan 3 的精确 source/test/README 文件，预算为 `{ maxFiles: 6, maxChangedLines: 260 }`。

仅当 `.fork/features.yaml` 表示 `adapted` 时，添加预算为 `{ maxFiles: 3, maxChangedLines: 220 }` 的 `bounded-compaction-input` 作为 `product-patch`。

仅当 `.fork/features.yaml` 表示 `adapted` 时，添加预算为 `{ maxFiles: 2, maxChangedLines: 160 }` 的 `subagent-per-call-model-routing` 作为 `product-patch`。

为确切的 `packages/boot/app-boot/src/profile.ts` 和 `packages/boot/app-boot/tests/profile.spec.ts` 路径添加 `fork-web-profile-template` 作为 `product-patch`，预算为 `{ maxFiles: 2, maxChangedLines: 40 }`。

- [ ] **步骤 4：消除每个未覆盖或重叠路径**

运行：`pnpm run verify-fork-overlay`

对于 `uncovered-path`，将行为移入所属 fork 包，将确切的生成/composition 路径添加到已有条目，或创建一个有独立理由的有界 patch。对于 `overlapping-coverage`，缩小条目；永远不要让验证器选择赢家。对于 `stale-entry`，移除条目，并将 `.fork/features.yaml` 更新为 `upstreamed` 或 `retired`。

预期：`fork-overlay: PASS`。

- [ ] **步骤 5：激活普通变更的门禁并提交**

将 `pnpmScript('fork-overlay', 'verify-fork-overlay', { label: 'fork overlay' })` 添加到 `ciSharedStaticGates()` 和 `check-all`，然后扩展现有的 `scripts/run-gates.spec.ts` 断言，使 `ci-static` 和 `check-all` 各自恰好包含一次该门禁。运行 `pnpm exec vitest run scripts/run-gates.spec.ts` 和 `pnpm run verify-fork-overlay`，两者都必须通过。

```bash
git add .fork/overlay.yaml .fork/README.md .fork/features.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.host.json tsconfig.client.json packages/README.md docs scripts/run-gates.ts scripts/run-gates.spec.ts
git commit -m "feat(fork): activate overlay inventory"
```

### 任务 2：构建合并准备和报告约定

**文件：**
- 创建：`scripts/upstream-sync/types.ts`
- 创建：`scripts/upstream-sync/prepare.ts`
- 创建：`scripts/upstream-sync/context.ts`
- 创建：`scripts/upstream-sync/report.ts`
- 测试：`scripts/upstream-sync/prepare.spec.ts`
- 测试：`scripts/upstream-sync/report.spec.ts`

**接口：**
- 产出 `pnpm exec tsx scripts/upstream-sync/prepare.ts --upstream "$UPSTREAM_SHA" --context "$RUNNER_TEMP/sync-context.json"`。
- 产出 `validateResolutionReport(report, context): ResolutionReport`。

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

- [ ] **步骤 1：编写失败的 prepare 测试**

在临时仓库中证明：无冲突合并会写入上下文并留下可提交的 merge；content conflict、modify/delete conflict 和 rename/delete conflict 保持未合并并以 stage facts 出现；fork-owned 路径冲突在合并前就作为 blocker 出现；缺失的确切上游提交失败。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run scripts/upstream-sync/prepare.spec.ts scripts/upstream-sync/report.spec.ts`

预期：失败，因为脚本不存在。

- [ ] **步骤 3：不使用 shell 实现准备**

使用带显式 Git 参数的 `execFile`。`prepare.ts` 验证候选分支干净，加载旧 manifest，检查传入提交，使用请求的上游 SHA 运行 `git merge --no-commit --no-ff`，仅将工作区 manifest 中的 `upstreamCommit` 重写为该 SHA，并在 Git 稳定后写入上下文。在内存中保留旧 manifest，以进行所有权和影响分析。退出码：`0` 表示无冲突合并已准备好；`2` 表示需要 resolver 的冲突；`1` 表示准备本身失败。它永远不调用 `git add`、checkout 侧解决、commit、push 或 reset。

- [ ] **步骤 4：实现严格的报告验证**

要求每个受影响 overlay 条目恰好有一个 disposition，未受影响的 id 不得有 disposition。`filesChanged` 必须是候选 diff 的子集，并且每个文件都必须由该条目覆盖。`testsRun` 必须等于或包含渲染为规范命令的每个 manifest 验证目标。`upstreamed` 和 `retired` 条目在解决后的 diff 中必须是 stale；`preserved` 和 `adapted` 条目必须仍被覆盖。

- [ ] **步骤 5：运行并提交**

运行：`pnpm exec vitest run scripts/upstream-sync/prepare.spec.ts scripts/upstream-sync/report.spec.ts`

```bash
git add scripts/upstream-sync/types.ts scripts/upstream-sync/prepare.ts scripts/upstream-sync/context.ts scripts/upstream-sync/report.ts scripts/upstream-sync/prepare.spec.ts scripts/upstream-sync/report.spec.ts
git commit -m "feat(sync): prepare normal upstream merges"
```

### 任务 3：仅完成已解决且已验证的候选分支

**文件：**
- 创建：`scripts/upstream-sync/finalize.ts`
- 测试：`scripts/upstream-sync/finalize.spec.ts`
- 修改：`package.json`

**接口：**
- 产出 `pnpm run finalize-upstream-sync -- --upstream "$UPSTREAM_SHA" --report "$RUNNER_TEMP/resolution-report.json"`。

- [ ] **步骤 1：编写失败的 finalizer 测试**

拒绝未解决的 index stage、缺少 `MERGE_HEAD`、不同于 `MERGE_HEAD` 的报告 SHA、不同于传入提交的 manifest SHA、无效的报告 disposition、overlay 诊断、resolver 未暂存的脏编辑，以及与合并前 fork 相同的 tree。证明有效候选分支只重新生成声明的生成输出并创建一个 merge commit。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run scripts/upstream-sync/finalize.spec.ts`

预期：失败，因为 finalizer 不存在。

- [ ] **步骤 3：实现快速失败的 finalization**

finalizer 按以下顺序执行检查：没有 unmerged 条目；报告有效；`.fork/overlay.yaml` 记录 `MERGE_HEAD`；`pnpm install --lockfile-only`；声明的 catalog generator；overlay 验证器；必需的聚焦验证。它只暂存合并/resolver 已变更的文件以及声明的生成输出，然后使用 `git commit --no-edit` 提交。任何失败都会在不 push 的情况下保留候选分支和诊断。

添加：

```json
"finalize-upstream-sync": "tsx scripts/upstream-sync/finalize.ts"
```

- [ ] **步骤 4：运行并确认 GREEN**

运行：`pnpm exec vitest run scripts/upstream-sync/finalize.spec.ts`

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add scripts/upstream-sync/finalize.ts scripts/upstream-sync/finalize.spec.ts package.json
git commit -m "feat(sync): finalize verified candidates"
```

### 任务 4：替换 resolver 和 reviewer prompt

**文件：**
- 创建：`.github/review/upstream-resolver-task.md`
- 创建：`.github/review/upstream-reviewer-task.md`
- 删除：`.github/review/reviewer-task.txt`
- 修改：`.github/review/headless-settings.yaml`
- 删除：`scripts/import-review-session.sh`
- 测试：`scripts/upstream-sync/prompts.spec.ts`

**接口：**
- Resolver 读取生成的 `SyncContext`，只编辑候选分支，运行确切的必需检查，并写入 `resolution-report.json`。
- Reviewer 读取上下文、报告、完整 diff 和证据，并写入 `{ safe, summary, risks, rejectedDispositions }`。

- [ ] **步骤 1：编写失败的 prompt 约定测试**

断言 resolver prompt 禁止选择整个一侧、写入 master、抑制检查、部署和伪造测试证据；要求上游意图、每个条目一个 disposition、确切的报告路径和未解决冲突检查。断言 reviewer 独立工作、拒绝未注册 diff 和被削弱的测试，并且绝不把单独编译视为充分证据。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run scripts/upstream-sync/prompts.spec.ts`

预期：失败，因为新的 prompt 不存在。

- [ ] **步骤 3：编写基于仓库的 prompt**

Resolver 先读取 `DSH_SYNC_CONTEXT_PATH` 指定的绝对文件、`.fork/overlay.yaml`、受影响的 Agent Note 和上下文中列出的每个上游提交。它将报告写入 `DSH_SYNC_REPORT_PATH` 指定的绝对文件；两个路径都位于 `RUNNER_TEMP` 下，永远不会进入候选 diff。只有在上下文证明另一侧没有所有权冲突后，它才可以对 fork-owned exact 路径使用 `git checkout --ours/--theirs`；绝不能对上游所有的包使用这些命令。只有写入严格 JSON 且没有未合并 stage 后，它才结束。

Reviewer 会获得全新的 DSH home，并且必须检查 `master...HEAD`、`resolution-report.json`、`fork-overlay` 输出、聚焦检查以及两个 Web 证据输出。

- [ ] **步骤 4：运行并确认 GREEN**

运行：`pnpm exec vitest run scripts/upstream-sync/prompts.spec.ts`

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add -A .github/review scripts/import-review-session.sh scripts/upstream-sync/prompts.spec.ts
git commit -m "ci(sync): define resolver and reviewer contracts"
```

### 任务 5：围绕仅候选分支解决重写 GitHub workflow

**文件：**
- 修改：`.github/workflows/upstream-sync.yml`
- 修改：`.github/workflows/upstream-review.yml`
- 测试：`scripts/upstream-sync/workflows.spec.ts`

**接口：**
- Sync 上传 `sync-context`、`resolution-report` 和命令日志。
- Review 仅在必需门禁通过且 reviewer 返回 `safe: true` 时合并。

- [ ] **步骤 1：编写失败的 workflow 策略测试**

解析两个 YAML 文件并拒绝 `-X ours`、`-X theirs`、`checkout --ours`、`checkout --theirs`、`git push -f`、完整恢复 `.github/workflows`、直接 checkout `master` 进行写入、在必需证据上使用 `continue-on-error` 以及任何 deploy 命令。要求仅在替换候选分支时使用 `--force-with-lease`，要求精确的 workflow 路径处理、overlay 验证、两个 Web composition 检查、resolver 产物、reviewer 产物和仅 PR 合并。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run scripts/upstream-sync/workflows.spec.ts`

预期：针对当前 fork 优先的 workflow 失败。

- [ ] **步骤 3：重写 upstream-sync**

工作流 checkout `master`，获取确切的上游 SHA，记录 `PREVIOUS_REMOTE_SHA=$(git rev-parse --verify refs/remotes/origin/sync/upstream-master 2>/dev/null || printf '%040d' 0)`，创建 `sync/upstream-master`，并使用位于 `RUNNER_TEMP` 下的上下文运行 `prepare.ts`。退出 `1` 表示失败。退出 `0` 且没有受影响条目时写入零条目报告。退出 `0` 且有受影响条目，或退出 `2` 时，使用已提交的 prompt 启动 headless resolver/impact agent；退出 `2` 时还必须解决冲突。之后 `finalize.ts` 验证报告，使用 `--force-with-lease=refs/heads/sync/upstream-master:$PREVIOUS_REMOTE_SHA` push 分支，并创建或更新 PR。

不要删除所有上游 workflow 变更。合并可以正常修改上游所有的 workflow；只有 manifest 中的两个 fork workflow 文件保持 fork-owned 并进行冲突检查。

- [ ] **步骤 4：重写 upstream-review**

运行 `pnpm install --frozen-lockfile`、`pnpm run verify-fork-overlay`、报告中的受影响聚焦目标、`pnpm run typecheck:contracts-ready`、变更运行时包的 built package invariant、针对 `web` 和 `fork-web` 的 `verify-web-composition`，以及 built browser smoke。只有在检查通过后才启动全新的独立 reviewer agent。仅当严格 verdict 为 safe 且 GitHub 必需检查为绿色时，才使用 merge commit 合并 PR。

- [ ] **步骤 5：运行策略测试并提交**

运行：`pnpm exec vitest run scripts/upstream-sync/workflows.spec.ts`

```bash
git add .github/workflows/upstream-sync.yml .github/workflows/upstream-review.yml scripts/upstream-sync/workflows.spec.ts
git commit -m "ci(sync): resolve upstream on candidate branches"
```

### 任务 6：添加完整同步和损坏 Web 模拟

**文件：**
- 创建：`scripts/upstream-sync/simulate.spec.ts`
- 仅为非生成 fixture 源创建：`scripts/upstream-sync/fixtures/`

**接口：**
- 产出无冲突、冲突、冲突、陈旧、预算和 Web 产物失败案例的确定性证据。

- [ ] **步骤 1：编写模拟矩阵**

每个测试创建一个临时 bare upstream、fork clone 和 candidate clone。覆盖：

1. 无冲突的上游编辑到达候选分支；
2. content conflict 退出 `2`，没有报告就不能 finalize；
3. modify/delete conflict 保持未解决；
4. rename/delete conflict 保持未解决；
5. 上游创建 fork-owned 路径，准备阶段在解决前失败；
6. 上游实现一个 patch，preserved 报告因 stale 失败；
7. patch 变更行超过预算；
8. resolver 报告遗漏一个受影响条目；
9. 构建出的 HTML 缺少 CSS；
10. fork plugin 从 boot metadata 中消失。

- [ ] **步骤 2：在所有 fixture 接通前运行并确认失败**

运行：`pnpm exec vitest run scripts/upstream-sync/simulate.spec.ts`

预期：在 helper 驱动每个失败分支之前为 RED。

- [ ] **步骤 3：完成 fixture harness**

使用明确的临时路径和本地 Git remote。不要调用网络、GitHub 或真实模型。Resolver 成功由一个编辑冲突文件并写入严格报告的 fixture callback 表示；这测试的是编排，不是模型质量。

- [ ] **步骤 4：运行矩阵和 overlay 测试**

运行：`pnpm exec vitest run scripts/upstream-sync scripts/fork-overlay scripts/web-composition`

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add scripts/upstream-sync/simulate.spec.ts scripts/upstream-sync/fixtures
git commit -m "test(sync): simulate overlay merge failures"
```

### 任务 7：运行真实 dry-run sync 并完成迁移验收

**文件：**
- 只有证据发现真实缺陷时才修改：Plan 1-4 所属的实现、测试或文档文件。
- 创建：`.fork/migration/cutover-evidence.md`
- 为完成的迁移创建一个带 EN/ZH 配对的 Agent Note。

**接口：**
- 产出经过评审的证据，证明当前候选分支可以通过生产脚本消费一个更新的真实或合成上游提交。

- [ ] **步骤 1：获取并选择 dry-run 目标**

获取 `upstream/master`。如果它比 `.fork/overlay.yaml.upstreamCommit` 更新，使用该确切 SHA。如果没有变化，则创建一个本地合成上游提交，修改一个上游所有的文档文件和一个不冲突的 client 测试 fixture；记录源 SHA 和合成 SHA。

- [ ] **步骤 2：在一次性候选分支上运行生产准备/finalization**

从迁移 head 创建 `codex/upstream-sync-dry-run`。运行 `prepare.ts`，仅在退出 `2` 时运行配置的 resolver，运行报告验证和 finalization。不要 push 该 dry-run 分支。

- [ ] **步骤 3：运行最终的适比例证据**

运行：`pnpm run verify-fork-overlay`

运行：`pnpm exec vitest run scripts/fork-overlay scripts/upstream-sync scripts/web-composition packages/fork packages/bundle/fork-base packages/bundle/fork-web packages/client/ui-workspace`

运行：`pnpm run typecheck`

运行：`pnpm run build`

运行：`pnpm run verify-built-package-invariants`

运行：`pnpm run verify-web-composition -- --profile web`

运行：`pnpm run verify-web-composition -- --profile fork-web`

运行：`pnpm run test:web:built -- packages/client/web-react/tests/fork-web-smoke.client.spec.tsx`

运行：`pnpm run doc-sync`

预期：所有相关的已跟踪 tree 检查通过。在 `cutover-evidence.md` 中记录确切命令、退出码、SHA、overlay 条目数、patch 预算和 Web plugin roster。

- [ ] **步骤 4：独立控制器验收**

控制器检查记录的上游父提交产生的完整 diff，针对其 Agent Note 和功能证据确认每个 manifest 条目，验证不存在 Codex，验证没有替换整个上游包，并读取 dry-run resolver/reviewer 产物。任何发现都返回所属任务，并且只重复受影响的检查。

- [ ] **步骤 5：提交证据并打开迁移 PR**

```bash
git add .fork/migration/cutover-evidence.md .agents/notes/implemented
git commit -m "docs(notes): complete plugin-first fork migration"
git push -u origin codex/plugin-first-overlay
gh pr create --base master --head codex/plugin-first-overlay --title "refactor(fork): adopt plugin-first upstream overlay" --body-file .fork/migration/cutover-evidence.md
```

只有在必需检查和控制器评审通过后才合并 PR。保留 recovery tag，直到至少一次后续上游同步成功完成。

## Plan 4 验收

- `.fork/overlay.yaml` 通过验证，每个最终 diff 路径都恰好覆盖一次。
- Workflow 和脚本不包含自动 fork 侧偏好。
- 未解决冲突、缺少报告、陈旧 patch、冲突、预算违规和损坏的 Web 产物都快速失败。
- Resolver 和 reviewer 是分离的、仅针对候选分支的 agent 运行。
- 真实或合成的 dry-run sync 通过同一条生产路径。
- 迁移 PR，而非自动化，是从迁移分支进入 `master` 的唯一路径。
