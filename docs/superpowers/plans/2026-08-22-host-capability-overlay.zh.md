# 主机能力覆盖层迁移实施计划

[English](2026-08-22-host-capability-overlay.md) | 中文

> **致智能体工作者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 子技能，逐任务执行本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 将 fork 迁移到选定的 upstream Host 基线，同时将所需的非 UI 行为保留为 fork 自有能力或范围严格受限的补丁，并移除已回退的 Codex 实现。

**架构：** 迁移首先捕获可观测行为，然后在隔离的 worktree 中执行一次正常的 upstream 合并。持久化的 fork 元数据使用独立服务、投影、设置和 Typert Remote，而不是扩展 upstream 会话头或 API Proxy 方法。流式超时策略使用文档化的 `llm/stream` waterfall。只有有界上下文压缩输入和按调用选择 subagent 模型仍是候选产品补丁；如果选定的 upstream 已经证明提供等效行为，则省略相应补丁。

**技术栈：** Cordis 服务和副作用、Typert Remote 生成、Zod 协议验证、Vitest、无密钥快照测试、Git worktree。

**规范：** `docs/superpowers/specs/2026-08-22-plugin-first-fork-overlay-design.zh.md`

## 全局约束

- 在 Plan 1 检查点创建的干净隔离 worktree 中执行；不要使用有未提交改动的主 checkout。
- 在 upstream 合并前创建带注释的恢复 tag，迁移期间不得移动或删除该 tag。
- 正常合并 `upstream/master`，使用 `--no-commit --no-ff`；不得使用 `-X ours`、`-X theirs`、按 checkout 一侧选择，或按包整体复制。
- upstream 已提供的行为记录为 `upstreamed`，不得重新实现。
- 每个对模型可见的 fork 事实都必须是持久化会话事件和投影。
- 一个 Host 能力包含 Service Definition、Provider、Consumer、生命周期测试和失败测试。
- 本计划完成后，不存在 `external-session-codex`、Codex 进程／协议 fixture 或 Codex UI。
- 保持现有无关的未跟踪 Agent Note 和探针脚本不变。

---

## 文件结构

- `.fork/features.yaml`：稳定的旧功能清单及处置证据。
- `.fork/migration/upstream-merge.md`：选定的 SHA、恢复 tag、冲突和解决提交。
- `.fork/migration/upstream-commit`：包含不可变选定 upstream SHA 的单行文件。
- `packages/fork/session-source/`：持久化的来源标记事件、投影、GitHub Actions producer，以及 Typert 可读取的投影数据。
- `packages/fork/workspace-session-state/`：持久化的会话置顶服务和 Typert Remote。
- `packages/fork/llm-first-chunk-timeout/`：可配置的 `llm/stream` waterfall 包装层。
- `packages/fork/external-session/`：仅包含与提供方无关的 Service Definition 和持久化外部 transcript 词汇。
- `packages/compaction/compaction-basic/`：仅在 upstream 缺少验收行为时使用的有界输入产品补丁。
- `packages/subagent/tool-subagent/`：仅在 upstream 缺少验收行为时使用的按调用模型选择产品补丁。
- `packages/bundle/fork-base/`：fork Host 插件的组合条目，在 upstream 基础层之后应用。

### 任务 1：捕获旧功能清单和验收映射

**文件：**
- 创建：`.fork/features.yaml`
- 创建：`.fork/migration/README.md`
- 测试：`scripts/fork-overlay/features.spec.ts`

**接口：**
- 生成一个由 Plan 3 和 Plan 4 消费的 `{ id, sourceCommits, requiredBehavior, evidence, disposition, replacement }` 记录列表。

- [ ] **步骤 1：编写失败的清单 schema 测试**

测试加载 `.fork/features.yaml`，拒绝未知键和重复 id，并要求以下精确 id：

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

允许的处置值为 `preserved`、`adapted`、`upstreamed`、`retired` 和 `deferred`。每条记录的 `evidence` 至少需要一个精确的测试文件。`retired` 和 `deferred` 记录必须包含非空的 `replacement` 说明。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run scripts/fork-overlay/features.spec.ts`

预期：失败，因为清单不存在。

- [ ] **步骤 3：写入合并前处置值的清单**

使用已经确定的提交来源：`078d3db591`、`eb25108045`、`842170d111`、`cc565b1065`、`44c01788c1`、`3a1558b55e..72ff0d079c` 和 `3eb7008e09`。将 `external-session-codex` 设为 `deferred`，其 replacement 设为 `A later opt-in Codex provider and Web bundle; no Codex runtime ships in this migration`。在 upstream 审计证明某项功能为 `upstreamed` 之前，将其他每条记录都设为 `adapted`。

对每条记录写一句描述可观测行为而非实现的句子。例如：

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

- [ ] **步骤 4：运行并确认 GREEN**

运行：`pnpm exec vitest run scripts/fork-overlay/features.spec.ts`

预期：通过。

- [ ] **步骤 5：提交清单**

```bash
git add .fork/features.yaml .fork/migration/README.md scripts/fork-overlay/features.spec.ts
git commit -m "docs(fork): inventory fork behaviors"
```

### 任务 2：建立 upstream 迁移基线

**文件：**
- 创建：`.fork/migration/upstream-merge.md`
- 创建：`.fork/migration/upstream-commit`
- 修改：仅修改有冲突的源文件以完成正常合并。

**接口：**
- 生成一个合并提交，其第二个父提交是精确选定的 upstream SHA；在 Plan 3 完成前不接受其中的 client 子树。

- [ ] **步骤 1：创建隔离 worktree 和恢复 tag**

从主 checkout 开始，执行 `superpowers:using-git-worktrees` 中的 worktree 流程。解析 `START_SHA=$(git rev-parse HEAD)`，在相邻 worktree `/Users/knyaz/deepseek-harness-plugin-first` 中创建分支 `codex/plugin-first-overlay`，然后在该 worktree 中运行：

```bash
git tag -a fork-overlay-recovery-2026-08-22 -m "pre plugin-first overlay migration" "$START_SHA"
git fetch upstream master
git rev-parse upstream/master
```

将得到的 40 字符 upstream SHA 记录在 `.fork/migration/upstream-merge.md` 中，并作为 `.fork/migration/upstream-commit` 的唯一一行。

- [ ] **步骤 2：开始正常合并并保留证据**

```bash
git merge --no-commit --no-ff upstream/master
git status --short
git diff --name-only --diff-filter=U
```

记录每个冲突路径。不要通过复制任一侧来解决 client 路径；Host 冲突解决后，Plan 3 会建立完整的 upstream client。

- [ ] **步骤 3：按行为归属解决 Host 冲突**

对于每个 Host 冲突，先阅读修改该文件的 upstream 提交以及所属包 README。保留 upstream 结构。将 fork 行为移入本计划指定的包。如果某项 fork 行为尚未迁移，选择 upstream 文件，并让其验收测试保持 RED，直到所属任务实现该行为。只有替换任务明确指定时，才删除旧的 fork 路径。

- [ ] **步骤 4：提交合并检查点**

`git diff --name-only --diff-filter=U` 没有输出后，在这个干净的隔离 worktree 中运行 `git add -A` 和 `git commit`。使用 Git 生成的合并消息。

使用以下命令验证：

```bash
git rev-list --parents -n 1 HEAD
git diff --name-only HEAD^2..HEAD -- packages/client
```

预期：有两个父提交；记录的流程中没有 `ours`／`theirs` 策略标记。

### 任务 3：将 GitHub Actions 来源保留为插件拥有的会话事件

**文件：**
- 创建：`packages/fork/session-source/package.json`
- 创建：`packages/fork/session-source/src/index.ts`
- 创建：`packages/fork/session-source/src/projection.ts`
- 创建：`packages/fork/session-source/src/types.ts`
- 创建：`packages/fork/session-source/tests/session-source.spec.ts`
- 创建：`packages/fork/session-source/README.md`
- 创建配对的 README 翻译文件。
- 修改：通过仓库生成器修改根 TypeScript face 配置和包目录。

**接口：**
- 生成带有 `{ source: 'github-actions' }` 的持久化事件 `fork/session-source`。
- 生成投影键 `forkSessionSource`，值为 `'github-actions' | undefined`。
- 消费 `Config.enabledWhenEnv: string`，默认值为 `GITHUB_ACTIONS`。

- [ ] **步骤 1：编写失败的事件和投影测试**

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

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run packages/fork/session-source/tests/session-source.spec.ts`

预期：失败，因为包不存在。

- [ ] **步骤 3：实现事件 producer 和投影**

通过合并 `SessionEventMap` 声明事件，仅当配置的环境键等于 `true` 时，才从 `ctx.on('session/created', ...)` 副作用追加该事件，并通过现有投影注册表注册投影。对于已知值，折叠规则采用最后写入生效；无法读取的 payload 必须被拒绝。

- [ ] **步骤 4：运行包测试并提供快照证据**

运行：`pnpm exec vitest run packages/fork/session-source`

添加或更新名为 `fork session source projection` 的最小无密钥 headless 快照，使 GitHub Actions fixture 暴露 `forkSessionSource`，同时不改变普通输出。运行 `pnpm run test:snapshot -- -t "fork session source projection"`。

- [ ] **步骤 5：提交**

```bash
git add packages/fork/session-source tsconfig.host.json packages/README.md docs/config-catalog.md
git commit -m "feat(fork): project GitHub Actions session source"
```

### 任务 4：将持久化 workspace 会话置顶添加为 Typert 能力

**文件：**
- 创建：`packages/fork/workspace-session-state/package.json`
- 创建：`packages/fork/workspace-session-state/src/index.ts`
- 创建：`packages/fork/workspace-session-state/src/types.ts`
- 创建：`packages/fork/workspace-session-state/tests/service.spec.ts`
- 创建：`packages/fork/workspace-session-state/README.md`
- 创建配对的 README 翻译文件。
- 修改：`packages/api/remotes/src/client/index.ts`
- 修改：通过仓库生成器修改生成的 Typert 产物。

**接口：**
- 生成服务 `ctx.forkWorkspaceSessionState`。
- 生成包含 `list()` 和 `setPinned()` 的 Typert 命名空间 `forkWorkspaceSessionState`。

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

- [ ] **步骤 1：编写失败的服务测试**

证明置顶／取消置顶的幂等性、稳定的插入顺序、提供方重新加载后的持久化、旧 revision 上的冲突、拒绝工作区注册表中不存在的 session id，以及由副作用拥有的 Remote 撤回。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run packages/fork/workspace-session-state/tests/service.spec.ts`

预期：失败，因为包不存在。

- [ ] **步骤 3：使用 settings 能力实现**

在命名空间 `fork.workspaceSessionState` 下、键 `pins` 中存储一个已验证值 `{ revision, sessionIds }`。写入前，针对权威 workspace 服务解析并验证被引用的 session。使用乐观 revision 检查，避免两个浏览器静默互相覆盖。只暴露生成的 Typert Remote；不要向 API Proxy 添加方法。

- [ ] **步骤 4：运行聚焦测试和生成产物检查**

运行：`pnpm exec vitest run packages/fork/workspace-session-state packages/api/remotes`

运行：`pnpm run gen-cordis-api`

运行：`pnpm run typecheck:contracts-ready`

预期：通过，且没有手动编辑的生成产物。

- [ ] **步骤 5：提交**

```bash
git add packages/fork/workspace-session-state packages/api/remotes/src/client/index.ts packages/README.md docs tsconfig.host.json tsconfig.client.json
git commit -m "feat(fork): persist workspace session pins"
```

### 任务 5：将首分片空闲超时添加为 LLM waterfall 插件

**文件：**
- 创建：`packages/fork/llm-first-chunk-timeout/package.json`
- 创建：`packages/fork/llm-first-chunk-timeout/src/index.ts`
- 创建：`packages/fork/llm-first-chunk-timeout/tests/timeout.spec.ts`
- 创建：`packages/fork/llm-first-chunk-timeout/README.md`
- 创建配对的 README 翻译文件。

**接口：**
- 消费文档化的 `llm/stream` waterfall，并使用 `next()` 委托。
- 配置：`{ firstChunkIdleTimeoutMs: number }`，正整数，默认值为 `120000`。

- [ ] **步骤 1：编写失败的 waterfall 测试**

证明在截止时间前发出分片的流保持不变并通过、静默流以现有可重试超时错误中止、首个分片后定时器被清除、调用方取消优先，以及没有挂载插件时 upstream 行为保持不变。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run packages/fork/llm-first-chunk-timeout/tests/timeout.spec.ts`

预期：失败，因为包不存在。

- [ ] **步骤 3：实现包装层**

使用 `ctx.on('llm/stream', async (request, next) => ...)` 注册一个 waterfall 监听器，准确调用一次 `next()`，并且仅在返回的异步可迭代对象产生首个分片之前对其进行包装。不要编辑 DeepSeek、Pi AI、retry 或 compaction 包。配置解析在插件加载时对零、负数、小数或不安全值失败。

- [ ] **步骤 4：运行测试和类型检查**

运行：`pnpm exec vitest run packages/fork/llm-first-chunk-timeout`

运行：`pnpm run typecheck:contracts-ready`

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add packages/fork/llm-first-chunk-timeout packages/README.md docs/config-catalog.md tsconfig.host.json
git commit -m "feat(fork): bound first LLM chunk idle time"
```

### 任务 6：协调有界上下文压缩和 subagent 路由

**文件：**
- 按需修改：`packages/compaction/compaction-basic/src/config.ts`
- 按需修改：`packages/compaction/compaction-basic/src/summarizer.ts`
- 按需测试：`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts`
- 按需修改：`packages/subagent/tool-subagent/src/index.ts`
- 按需测试：`packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`
- 修改：`.fork/features.yaml`

**接口：**
- 仅当 upstream 缺少等效的有界多轮行为时，上下文压缩配置才添加 `maxSummarizationInputTokens: number`，正整数，默认值为 `60000`。
- 仅当 upstream 缺少等效的按调用路由时，subagent 工具 schema 才添加可选的 `model?: string` 和 `reasoning_effort?: ReasoningEffortId`。

- [ ] **步骤 1：针对新的 upstream 树运行旧验收用例**

仅将提交 `078d3db591` 和 `3eb7008e09` 中的行为级测试移植到当前 upstream 测试结构中。在实现前运行它们。

预期：每项功能要么保持不变地通过并证明其为 `upstreamed`，要么因缺少行为而失败。

- [ ] **步骤 2：记录 upstreamed 行为，不添加补丁**

如果某项功能的所有验收用例都通过，将其 `.fork/features.yaml` 处置值设为 `upstreamed`，将 `replacement` 指向精确的 upstream 包／测试，并且不修改该功能的源代码。

- [ ] **步骤 3：仅在声明的预算内实现失败行为**

对于上下文压缩，限制呈现给每个摘要请求的历史，同时保留最新区域并允许后续轮次；不要截断持久化会话日志。预算：最多 3 个 upstream 源文件和 220 行改动。

对于 subagent 路由，在工具 JSON 边界验证模型和推理强度，将它们转发到提供方请求解析后的 agent 选项中，并让省略字段时的行为与 upstream 完全一致。预算：最多 2 个 upstream 源文件和 160 行改动。

- [ ] **步骤 4：运行聚焦测试**

运行：`pnpm exec vitest run packages/compaction/compaction-basic packages/subagent/tool-subagent`

预期：通过。

- [ ] **步骤 5：按功能独立提交**

```bash
git add .fork/features.yaml packages/compaction/compaction-basic
git commit -m "fix(compaction): bound summarization input"
```

```bash
git add .fork/features.yaml packages/subagent/tool-subagent
git commit -m "feat(subagent): route model per delegation"
```

当某项功能已经 upstreamed 且只修改了清单时，跳过对应提交；将该清单改动并入下一次文档提交。

### 任务 7：只保留与提供方无关的 external-session seam

**文件：**
- 创建：`packages/fork/external-session/package.json`
- 创建：`packages/fork/external-session/src/index.ts`
- 创建：`packages/fork/external-session/src/types.ts`
- 创建：`packages/fork/external-session/tests/service.spec.ts`
- 创建：`packages/fork/external-session/README.md`
- 创建配对的 README 翻译文件。
- 删除：`packages/external/external-session-codex/`
- 删除：当没有非 Codex 提供方消费它时，删除过时的 `packages/external/external-session-bridge/`。
- 删除：当只有 Codex 消费它时，删除 `packages/interaction/external-permission/`。
- 使用 `dsh-archive-agent-notes` 归档：已实现的 Phase 1 external-session 注记和已被取代的 proposed external-session 注记，包括它们的翻译配对文件。
- 删除：`.agents/plans/2026-08-18-external-sessions/`
- 修改：`.fork/features.yaml`

**接口：**
- 生成可通过声明合并扩展的 `ExternalSessionModeMap`，以及拥有副作用的注册表服务 `register(mode, provider): () => void`。
- 不包含默认提供方、进程运行器、权限桥、transcript 渲染器或组合包条目。

- [ ] **步骤 1：编写失败的 seam 测试**

证明 mode id 唯一、disposer 所有权、提供方查找失败、空注册表作为有效组合，以及类型安全的声明合并扩展。不要移植 Codex 协议 fixture。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run packages/fork/external-session/tests/service.spec.ts`

预期：失败，因为包不存在。

- [ ] **步骤 3：实现最小 Service Definition**

仅暴露注册和查找。在真实提供方建立 Codex 后续项目所需的具体持久化事实之前，不要加入 transcript 事件词汇。将 `external-session-generic` 更新为 `adapted`，将 `external-session-codex` 更新为 `deferred`。移动活跃的 Phase 1／proposed 注记前调用 `dsh-archive-agent-notes`，使归档记录正确的取代状态；在其所属注记归档后删除过时的执行计划。

- [ ] **步骤 4：删除 Codex 专属路径并证明其不存在**

运行：

```bash
git grep -n -E 'external-session-codex|codex app-server|codex/mcp|CodexProvider' -- packages apps examples .github || true
```

预期：运行时或默认组合中没有匹配项。历史 Agent Note 可以命名已退休的实现，并保持不可变。

- [ ] **步骤 5：运行聚焦测试并提交**

运行：`pnpm exec vitest run packages/fork/external-session`

```bash
git add -A packages/external packages/interaction/external-permission packages/fork/external-session .agents/notes .agents/plans/2026-08-18-external-sessions .fork/features.yaml packages/README.md tsconfig.host.json
git commit -m "refactor(external): retain provider-neutral session seam"
```

### 任务 8：组合 fork Host 层

**文件：**
- 创建：`packages/bundle/fork-base/package.json`
- 创建：`packages/bundle/fork-base/cordis.patch.yml`
- 创建：`packages/bundle/fork-base/src/index.ts`
- 创建：`packages/bundle/fork-base/src/invariant.ts`
- 创建：`packages/bundle/fork-base/tests/fork-base.spec.ts`
- 创建：`packages/bundle/fork-base/README.md`
- 创建配对的 README 翻译文件。

**接口：**
- 生成一个应用在 upstream `dsh-base` 之后的组合包。
- 挂载 `fork-session-source`、`fork-workspace-session-state` 和 `fork-llm-first-chunk-timeout`；不挂载 Codex 提供方。

- [ ] **步骤 1：编写失败的组合包测试**

转储组合后的配置，并断言三个 fork 条目出现在其 upstream 依赖之后、id 唯一、每个条目都可以由后续补丁禁用或重新配置，并且没有替换任何 upstream 基础条目。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run packages/bundle/fork-base/tests/fork-base.spec.ts`

预期：失败，因为组合包不存在。

- [ ] **步骤 3：实现组合包**

补丁仅包含 `insert` 条目。为部署变化的超时提供显式配置。不要编辑 `packages/bundle/base/cordis.patch.yml`。

- [ ] **步骤 4：运行包和配置门禁**

运行：`pnpm exec vitest run packages/bundle/fork-base packages/fork`

运行：`pnpm run verify-cordis-config`

运行：`pnpm run verify-package-invariants`

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add packages/bundle/fork-base packages/README.md docs/config-catalog.md pnpm-lock.yaml tsconfig.host.json
git commit -m "feat(fork): compose host overlay bundle"
```

## Plan 2 验收

- 迁移提交以选定的 `upstream/master` SHA 为父提交，并且不记录合并一侧优先策略。
- `.fork/features.yaml` 为每项已知的已提交 fork 功能包含一个处置值和可运行证据。
- 会话来源、workspace 置顶和首分片超时均由插件拥有。
- 上下文压缩和 subagent 补丁仅针对 upstream 尚未提供的行为存在，并且保持在各自预算内。
- 默认 upstream 基础组合包保持不变。
- 不存在 Codex 运行时、协议 fixture、权限桥、UI 或默认组合。
