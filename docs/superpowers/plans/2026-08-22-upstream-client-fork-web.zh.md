# 上游 Client 与 Fork Web 组合实施计划

[English](2026-08-22-upstream-client-fork-web.md) | 中文

> **致智能体工作者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 子技能，逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 将选定的完整上游 client 作为基线，通过增量式 client 插件和独立的 fork Web bundle 恢复 fork workspace 行为，不替换 conversation shell、InputBar、theme、runtime 或上游 Web bundle。

**架构：** 迁移只将上游所有的 client 路径重置到合并的上游父提交，然后针对当前 slot 和 Typert remote 移植行为。两个通用的 ui-workspace 扩展点暴露 row contribution 和 list policy，但不包含 fork 逻辑。一个 fork-owned UI 插件提供 copy-id、unread、background、GitHub Actions badge 和 pin 行为。Fork Web bundle 在上游 Web 组合之后叠加 fork-base 和该 UI 插件。两种组合都运行 built-artifact 和浏览器证明。

**技术栈：** React 19、client Cordis slot 和 store、Typert Client Remote、CSS Modules、Vite、Vitest/JSDOM、built Web snapshot harness。

**规范：** `docs/superpowers/specs/2026-08-22-plugin-first-fork-overlay-design.md`

## 全局约束

- 从 Plan 2 迁移分支及其确切的上游合并父提交开始。
- 在移植 fork 行为之前，从上游父提交恢复上游所有的 `packages/client/` 文件。
- 不要恢复旧 fork 版本的 `InputBar`、`ConversationRoot`、theme、runtime manager 或 Web bootstrap。
- Client feature 包通过 `ctx.effect()`、`ctx.slots.inject()` 或记录在案的 Client service 注册，并同步 dispose。
- 没有 contributor 挂载时，通用扩展 patch 保持上游可观察行为逐字节不变。
- Extension patch 预算：最多 6 个上游 ui-workspace source 文件和 260 行变更，包括测试但不包括生成 catalog。
- Fork UI 包绝不从上游 client 包导入私有文件。
- 默认上游 Web bundle 不包含 fork row，并通过自身的 built proof。

---

## 文件结构

- `packages/client/ui-workspace/src/client/contract/contributions.ts`：通用 row/badge/filter/sort contribution 类型。
- `packages/client/ui-workspace/src/client/contributions.ts`：由 effect 所有的 registry 和 snapshot source。
- `packages/client/ui-workspace/src/client/rows/Rows.tsx`：仅包含通用 row render site。
- `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`：仅包含通用 filter tab 和 policy 应用。
- `packages/fork/ui-workspace-overlay/`：所有 fork workspace 行为和展示。
- `packages/bundle/fork-web/`：添加 fork-base 和浏览器插件 row 的组合层。
- `scripts/verify-web-composition.ts`：干净的 built-artifact CSS/bootstrap/plugin-roster 验证器。
- `apps/web/tests/fork-web-smoke.snapshot.ts`：已组合浏览器交互证明。

### 任务 1：建立完整的上游 client 基线

**文件：**
- 从合并父提交替换：`packages/client/`
- 当上游所有时从合并父提交替换：`packages/bundle/web-app/cordis.patch.yml` 中的 client 条目。
- 修改：`.fork/migration/upstream-merge.md`

**接口：**
- 产出一个 client tree，在加入 fork client 包之前与选定的上游父提交完全一致。

- [ ] **步骤 1：解析并记录上游合并父提交**

```bash
UPSTREAM_PARENT=$(tr -d '\n' < .fork/migration/upstream-commit)
git rev-parse "$UPSTREAM_PARENT"
git diff --name-status "$UPSTREAM_PARENT" -- packages/client
```

将 SHA 和重置前的 client diff 数量记录到 `.fork/migration/upstream-merge.md`。

- [ ] **步骤 2：恢复上游所有的 client 路径**

从确切的父提交使用 Git 的路径恢复：

```bash
git restore --source="$UPSTREAM_PARENT" --staged --worktree -- packages/client packages/bundle/web-app/cordis.patch.yml
```

仅当 `git cat-file -e "$UPSTREAM_PARENT:packages/client/ui-session-mode/package.json"` 证明该包不存在于上游，且 Plan 3 会替换或退出它时，才删除旧 client 包。具体来说，删除旧的 `packages/client/ui-session-mode/`；Codex mode selection 延后。

- [ ] **步骤 3：证明基线**

```bash
git diff --quiet "$UPSTREAM_PARENT" -- packages/client
```

预期：在添加 `packages/fork/ui-workspace-overlay` 或 extension patch 之前退出码为 `0`。

- [ ] **步骤 4：重新安装并运行上游 client smoke**

运行：`pnpm install --lockfile-only`

运行：`pnpm run typecheck:contracts-ready`

运行：`pnpm exec vitest run packages/client/ui-slots packages/client/runtime packages/client/ui-workspace packages/client/ui-conversation`

预期：在上游基线上通过。由 Host 迁移导致的失败应在 API/package interface 处修复，而不是恢复旧的 client 内部实现。

- [ ] **步骤 5：提交基线**

```bash
git add -A packages/client packages/bundle/web-app/cordis.patch.yml tsconfig.client.json pnpm-lock.yaml .fork/migration/upstream-merge.md
git commit -m "refactor(client): restore upstream baseline"
```

### 任务 2：添加通用 workspace contribution 点

**文件：**
- 创建：`packages/client/ui-workspace/src/client/contract/contributions.ts`
- 创建：`packages/client/ui-workspace/src/client/contributions.ts`
- 修改：`packages/client/ui-workspace/src/client/contract/slots.ts`
- 修改：`packages/client/ui-workspace/src/client/index.ts`
- 修改：`packages/client/ui-workspace/src/client/rows/Rows.tsx`
- 修改：`packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`
- 测试：`packages/client/ui-workspace/tests/contributions.client.spec.tsx`
- 修改配套的 package README 文件。

**接口：**
- 产出 Client service `ctx.workspaceContributions`。

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

添加 slot：

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'workspace.session-row.badges': { kind: 'list'; scope: 'root'; owner: WorkspaceSessionRowContext }
    'workspace.session-row.actions': { kind: 'list'; scope: 'root'; owner: WorkspaceSessionRowContext }
  }
}
```

- [ ] **步骤 1：编写失败的空路径/有 contribution 路径测试**

证明零注册保留上游 DOM snapshot 和排序。注册一个 view、一个全局排序 policy、一个 badge 和一个 action；证明 view 和 policy 按 `(order, id)` 排序，重复 id 在各自 registry 内失败，注销恢复空路径，并且抛出异常的 predicate/comparator 会产生已上报的 plugin error，而不是静默丢弃 session。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run packages/client/ui-workspace/tests/contributions.client.spec.tsx`

预期：失败，因为 registry 和 slot 不存在。

- [ ] **步骤 3：实现 extension patch**

由于 ui-workspace 控制 list 语义，因此由它拥有 registry。通过插件的 Cordis context 注册 service，并通过 effect 注册每个条目。`WorkspaceBrowser` 保留上游默认 view 作为内部且不可移除的 fallback，仅当至少存在一个贡献时才渲染贡献的 view tab，并在当前 view filter 之后应用每个注册的排序 policy，因此这些 policy 也会影响 fallback view。`Rows` 调用两个新增的 render site，但不包含 fork id、copy、pin、source、unread 或 background 条件。

- [ ] **步骤 4：运行聚焦 client 测试和预算检查**

运行：`pnpm exec vitest run packages/client/ui-workspace`

运行：

```bash
git diff --numstat "$UPSTREAM_PARENT" -- packages/client/ui-workspace
```

预期：extension patch 不超过 6 个变更 source 文件和 260 行。如果超出预算，将 presentation 拆分到 fork 包，而不是提高预算。

- [ ] **步骤 5：提交**

```bash
git add packages/client/ui-workspace
git commit -m "feat(ui-workspace): add list contribution points"
```

### 任务 3：实现 fork workspace UI 插件

**文件：**
- 创建：`packages/fork/ui-workspace-overlay/package.json`
- 创建：`packages/fork/ui-workspace-overlay/src/index.ts`
- 创建：`packages/fork/ui-workspace-overlay/src/client/index.ts`
- 创建：`packages/fork/ui-workspace-overlay/src/client/store.ts`
- 创建：`packages/fork/ui-workspace-overlay/src/client/WorkspaceRowActions.tsx`
- 创建：`packages/fork/ui-workspace-overlay/src/client/WorkspaceRowBadges.tsx`
- 创建：`packages/fork/ui-workspace-overlay/src/client/BackgroundView.tsx`
- 创建：`packages/fork/ui-workspace-overlay/src/client/workspace-overlay.module.css`
- 创建：`packages/fork/ui-workspace-overlay/src/client/locales.ts`
- 创建：`packages/fork/ui-workspace-overlay/tests/workspace-overlay.client.spec.tsx`
- 创建：`packages/fork/ui-workspace-overlay/README.md`
- 创建配套的 README 翻译文件。

**接口：**
- 消费 `ctx.workspaceContributions`、`ctx.slots`、`ctx.remote.forkWorkspaceSessionState`、session summary/projection 和浏览器 clipboard。
- 产出 `Background` view 以及两个 workspace row slot 中的条目。

- [ ] **步骤 1：编写失败的行为测试**

在一个已组合的 client fixture 中覆盖以下行为：

- Copy Session ID 写入确切的 opaque id，并以可访问的方式报告 clipboard rejection。
- Mark unread 将浏览器本地 read watermark 设置到 session 当前 last sequence 之下；打开 session 时再次推进它。
- Background 包含 live/running session，以及 `forkSessionSource` 为 `github-actions` 的 session，但不移动普通 idle session。
- GitHub Actions badge 仅在 projection 值为 `github-actions` 时渲染。
- Pin/unpin 使用已观察的 revision 调用 Typert Remote；stale revision 只重新获取一次，并要求第二次显式点击，而不是重放 mutation。
- Pinned session 在其 workspace 内排在 unpinned session 之前，同时保持每个分区内的上游顺序。
- Dispose 插件会移除它的 view、badge、action、subscription 和 locale namespace。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run packages/fork/ui-workspace-overlay/tests/workspace-overlay.client.spec.tsx`

预期：失败，因为包不存在。

- [ ] **步骤 3：实现 store 和 contribution**

分开保存 server pin 和 client read watermark。将 read watermark 持久化到有版本的单个 `localStorage` key `dsh.fork.workspaceReadWatermarks.v1` 下；对格式严格解析，并在浏览器本地数据格式错误时安全地回退为空值。在 Host 接受之前，不要乐观地写入 pin 状态。

注册 id 为 `fork.background`、order 为 `100` 的 `Background`。注册 id 为 `fork.pinned-first`、order 为 `100` 的 pin 排序 policy；它将 pinned 分区放在 unpinned 之前，并在每个分区内返回 `0`，从而保持上游顺序稳定。注册 row action id `fork.copy-session-id`、`fork.mark-unread` 和 `fork.pin-session`。注册一个 badge 条目 `fork.github-actions-source`。使用上游 primitive 和 theme token；不允许使用全局 CSS selector。

- [ ] **步骤 4：运行包测试和跨包测试**

运行：`pnpm exec vitest run packages/fork/ui-workspace-overlay packages/client/ui-workspace packages/fork/workspace-session-state packages/fork/session-source`

运行：`pnpm run typecheck:contracts-ready`

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add packages/fork/ui-workspace-overlay packages/README.md tsconfig.client.json pnpm-lock.yaml
git commit -m "feat(fork): add workspace UI overlay"
```

### 任务 4：组合独立的 fork Web bundle

**文件：**
- 创建：`packages/bundle/fork-web/package.json`
- 创建：`packages/bundle/fork-web/cordis.patch.yml`
- 创建：`packages/bundle/fork-web/src/index.ts`
- 创建：`packages/bundle/fork-web/src/invariant.ts`
- 创建：`packages/bundle/fork-web/tests/fork-web.spec.ts`
- 创建：`packages/bundle/fork-web/README.md`
- 创建配套的 README 翻译文件。
- 修改：`packages/boot/app-boot/src/profile.ts`
- 测试：`packages/boot/app-boot/tests/profile.spec.ts`

**接口：**
- 产出 profile `fork-web`，按顺序叠加上游 `base`、上游 `web-app`、`fork-base` 和 `fork-web`。
- 对已发布的 profile template table 添加一个有界 product patch：最多 2 个上游文件和 40 行变更。

- [ ] **步骤 1：编写失败的组合测试**

断言导出的 `web` profile 不包含任何 `fork-*` row。断言 `fork-web` 每个都恰好包含一行 session-source、workspace-session-state、first-chunk-timeout 和 ui-workspace-overlay。断言 `ui-theme`、`client-runtime`、`ui-conversation` 和 `ui-workspace` 仍解析到上游包名。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run packages/bundle/fork-web/tests/fork-web.spec.ts`

预期：失败，因为 bundle/profile 不存在。

- [ ] **步骤 3：实现 bundle/profile 组合**

Fork Web patch 仅对 `ui-workspace-overlay` 使用 `insert`。Host fork row 仍由 `fork-base` 所有。Package metadata 将上游 bundle 列为依赖；source import 不得触及它们的私有文件。将 `fork-web` 添加到 `PROFILE_TEMPLATES`，值为 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-fork-base', '@deepseek-ai/dsh-fork-web']`，并证明现有 template 没有变化。

- [ ] **步骤 4：运行配置和 clean-build 门禁**

运行：`pnpm run verify-cordis-config`

运行：`pnpm run verify-client-packages`

运行：`pnpm run build:official`

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add packages/bundle/fork-web packages/boot/app-boot/src/profile.ts packages/boot/app-boot/tests/profile.spec.ts packages/README.md pnpm-lock.yaml
git commit -m "feat(fork): compose fork web profile"
```

### 任务 5：从干净产物验证 CSS、bootstrap 和 plugin roster

**文件：**
- 创建：`scripts/web-composition/types.ts`
- 创建：`scripts/web-composition/inspect.ts`
- 创建：`scripts/verify-web-composition.ts`
- 测试：`scripts/web-composition/inspect.spec.ts`
- 修改：`package.json`

**接口：**
- 产出 `pnpm run verify-web-composition -- --profile web|fork-web`。

```ts
export interface WebCompositionEvidence {
  readonly profile: 'web' | 'fork-web'
  readonly cssFiles: readonly string[]
  readonly bootstrapModule: string
  readonly pluginIds: readonly string[]
  readonly themePluginId: string
}
```

- [ ] **步骤 1：编写失败的产物测试**

使用 fixture dist 目录拒绝零 CSS 产物、缺少 bootstrap script、缺少 `ui-theme`、重复 plugin id、缺少上游 UI id 以及没有 `ui-workspace-overlay` 的 fork profile。证明上游 profile 拒绝任何 fork id。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run scripts/web-composition/inspect.spec.ts`

预期：失败，因为 inspector 不存在。

- [ ] **步骤 3：实现 inspector 和脚本**

读取构建出的 HTML 和生成的 boot metadata；不要将 source text 搜索作为证明。添加：

```json
"verify-web-composition": "tsx scripts/verify-web-composition.ts"
```

验证器在临时输出目录中运行 profile 专属的 clean build，检查它，然后在退出时只移除这个已验证的临时目录。

- [ ] **步骤 4：运行两种组合**

运行：`pnpm run verify-web-composition -- --profile web`

运行：`pnpm run verify-web-composition -- --profile fork-web`

预期：通过，并针对每个 profile 打印 CSS 数量、bootstrap module、theme id 和排序后的 plugin id。

- [ ] **步骤 5：提交**

```bash
git add scripts/web-composition scripts/verify-web-composition.ts package.json
git commit -m "test(web): verify assembled compositions"
```

### 任务 6：添加 built browser smoke

**文件：**
- 创建：`apps/web/tests/fork-web-smoke.snapshot.ts`
- 仅在需要选择 `fork-web` 时修改：`vitest.web.config.ts` 或现有 Web snapshot fixture registry。
- 修改：`.fork/features.yaml`

**接口：**
- 消费真实的 built plugin roster 和 fixture Host transport。
- 为两种 profile 证明 session input 和 settings/menu 交互。

- [ ] **步骤 1：编写失败的 browser smoke**

对于 `web`，启动构建出的应用，创建/打开 session，输入 `hello`，通过正常 composer 提交，打开 Settings，并断言捕获的 `window.error` 或 `console.error` 记录为零。对于 `fork-web`，重复该流程，打开 session row menu，复制 id，pin 它，打开 Background，并断言 GitHub Actions badge fixture。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm run test:web:built -- apps/web/tests/fork-web-smoke.snapshot.ts`

预期：失败，直到 built fixture 能够选择 fork profile。

- [ ] **步骤 3：不使用 source alias 接通 profile selector**

通过生产环境使用的同一条 built plugin metadata 路径选择 profile。不要为 source package 添加 Vite alias，也不要从测试中导入 client source。

- [ ] **步骤 4：运行完整 Web 证据**

运行：`pnpm run verify-web-composition -- --profile web`

运行：`pnpm run verify-web-composition -- --profile fork-web`

运行：`pnpm run test:web:built -- apps/web/tests/fork-web-smoke.snapshot.ts`

运行：`pnpm run website:build`

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add apps/web/tests/fork-web-smoke.snapshot.ts vitest.web.config.ts .fork/features.yaml
git commit -m "test(web): prove fork overlay interaction"
```

## Plan 3 验收

- `git diff "$(tr -d '\n' < .fork/migration/upstream-commit)" -- packages/client` 只包含有界的 ui-workspace extension patch；fork client 代码位于 `packages/fork/` 下。
- 旧的 `ui-session-mode` 和所有 Codex transcript UI 都不存在。
- 上游 `web` 不包含 fork plugin，并通过 CSS/bootstrap/input/settings 证据。
- `fork-web` 添加 fork roster，并通过相同证据以及 workspace action。
- 没有 fork source 导入上游私有文件，也没有替换 InputBar、conversation shell、theme、client runtime 或上游 Web 组合。
