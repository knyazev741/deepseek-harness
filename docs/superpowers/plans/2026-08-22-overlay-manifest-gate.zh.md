# Overlay Manifest 与验证门禁实施计划

[English](2026-08-22-overlay-manifest-gate.md) | 中文

> **致智能体工作者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 子技能，逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 构建一个源代码平面验证器，针对不可变的上游提交对每个 fork 差异进行分类，并拒绝重叠、陈旧条目、所有权冲突、整包声明、无效验证目标以及补丁预算违规。

**架构：** 一个小型的类型化核心解析 `.fork/overlay.yaml`，通过注入的 Git reader 获取不可变的 tree 和 numstat 数据，并在不改变 Git 的情况下返回确定性诊断。CLI 提供真实的 Git 适配器。第一份计划会针对 fixture 仓库测试完整验证器，但在 Plan 4 的迁移完成并具备完整 manifest 之前，不会将其加入 `ci-static`。

**技术栈：** TypeScript 6、Node `child_process.execFile`、`js-yaml`、Vitest、Git plumbing 命令。

**规范：** `docs/superpowers/specs/2026-08-22-plugin-first-fork-overlay-design.md`

## 全局约束

- 直接使用 `upstream/master`，不引入镜像分支。
- Git 保持为真源；仓库不存储重复的补丁文件。
- 路径覆盖必须是精确覆盖或目录树覆盖；禁止 glob 语法。
- 每个变更路径必须且只能由一个条目覆盖。
- fork 所有路径必须不存在于记录的上游 tree 中。
- extension 或 product patch 不得声明整个上游包。
- CLI 为只读，并在 manifest 或分类错误时以退出码 `1` 快速失败。
- 不得使用临时通配符或兼容性类别为旧的全仓库差异背书。

---

## 文件结构

- `scripts/fork-overlay/types.ts`：公开的 manifest、Git fact 和诊断类型。
- `scripts/fork-overlay/manifest.ts`：严格的 YAML 解析和语义验证。
- `scripts/fork-overlay/classify.ts`：路径覆盖和逐条目预算核算。
- `scripts/fork-overlay/git-reader.ts`：只读 Git 适配器。
- `scripts/fork-overlay/verify.ts`：与仓库无关的验证编排。
- `scripts/verify-fork-overlay.ts`：CLI 和稳定诊断。
- `scripts/fork-overlay/*.spec.ts`：解析器、分类器、验证器和真实临时仓库测试。
- `.fork/README.md`：格式和迁移激活规则的操作员参考。
- `.agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.md`：设计记录及其配套翻译文件。

### 任务 1：定义并解析 manifest

**文件：**
- 创建：`scripts/fork-overlay/types.ts`
- 创建：`scripts/fork-overlay/manifest.ts`
- 测试：`scripts/fork-overlay/manifest.spec.ts`

**接口：**
- 消费：YAML 文本和 manifest 源名称。
- 产出：`parseOverlayManifest(text: string, source: string): OverlayManifest`。

- [ ] **步骤 1：编写失败的解析器测试**

覆盖一个完整 manifest，以及重复 id、非 40 位十六进制的上游提交、空路径列表、`..`、绝对路径、glob 元字符、没有尾部斜杠的 tree 路径、带尾部斜杠的 exact 路径、没有预算的 patch 条目和带预算的 fork-owned 条目。

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

- [ ] **步骤 2：运行解析器测试并确认 RED**

运行：`pnpm exec vitest run scripts/fork-overlay/manifest.spec.ts`

预期：失败，因为 `parseOverlayManifest` 不存在。

- [ ] **步骤 3：实现准确的类型和严格解析器**

使用以下公开类型词汇；不要添加 legacy 或 catch-all kind。

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

使用 `load(text, { schema: JSON_SCHEMA })` 解析，在每一层拒绝未知对象键，要求预算为正的安全整数，不规范化任何值，并将错误报告为源名称后跟解析器消息。

- [ ] **步骤 4：运行解析器测试并确认 GREEN**

运行：`pnpm exec vitest run scripts/fork-overlay/manifest.spec.ts`

预期：通过。

- [ ] **步骤 5：提交解析器**

```bash
git add scripts/fork-overlay/types.ts scripts/fork-overlay/manifest.ts scripts/fork-overlay/manifest.spec.ts
git commit -m "feat(fork): parse overlay manifest"
```

### 任务 2：将 Git 变更准确分类一次

**文件：**
- 创建：`scripts/fork-overlay/classify.ts`
- 测试：`scripts/fork-overlay/classify.spec.ts`

**接口：**
- 消费：`OverlayManifest`、`readonly DiffEntry[]` 和上游路径的 `ReadonlySet<string>`。
- 产出：`classifyOverlay(input: ClassificationInput): ClassificationResult`。

- [ ] **步骤 1：编写失败的分类测试**

使用带有旧路径和新路径的 rename、copy 记录，deletion，重叠的 exact/tree 条目，陈旧条目，同一条目中的 exact 加 tree 声明，`fork-owned`、`composition` 和 `workflow` 的 fork 侧冲突，与上游文件发生冲突的 tree 根路径，纯新增 patch 的所有权不匹配，有效的 deletion/rename/copy patch 锚点，超预算 patch，以及将 `packages/client/ui-workspace/` 声明为 tree 的 patch。

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

it('rejects an upstream-owned patch with no old/current path in upstream', () => {
  const result = classifyOverlay(fixture({
    entries: [makeEntry('new-patch', 'extension-patch', 'packages/upstream/new.ts', 'exact', {
      maxFiles: 1,
      maxChangedLines: 10,
    })],
    diffs: [{ status: 'A', path: 'packages/upstream/new.ts', added: 1, removed: 0, binary: false }],
    upstreamPaths: new Set(),
  }))
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'upstream-ownership-mismatch' }))
})
```

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run scripts/fork-overlay/classify.spec.ts`

预期：失败，因为分类器不存在。

- [ ] **步骤 3：实现覆盖和预算**

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
    | 'upstream-ownership-mismatch' | 'invalid-verification-target'
    | 'upstream-commit-missing'
  readonly message: string
  readonly entryId?: string
  readonly path?: string
}
```

Exact 路径只匹配相等值。Tree 路径匹配其目录及后代，并且只有在 manifest 路径以 `/` 结尾时才有效；tree 根路径若与上游文件的精确路径相同，也会发生冲突。`fork-owned`、`composition` 和 `workflow` 声明属于 fork 侧，声明的每个路径都必须不存在于上游。`extension-patch` 和 `product-patch` 声明属于上游侧，每个匹配的 diff 都必须至少有一个旧路径或当前路径存在于上游；deletion、rename 或 copy 使用 diff 记录中的上游路径作为锚点，因此新目标不必已经存在。对于没有上游锚点的 patch，发出 `upstream-ownership-mismatch`。rename 的旧路径和新路径都计入所有权，copy 同理，但任一 numstat 记录在预算中只计算一次。二进制变更计为一行变更，使二进制 patch 不能绕过预算。当 tree 覆盖恰好包含 `packages`、package group 和 package name 三个段时，该 patch 属于整包声明。

- [ ] **步骤 4：运行并确认 GREEN**

运行：`pnpm exec vitest run scripts/fork-overlay/classify.spec.ts`

预期：通过。

- [ ] **步骤 5：提交分类器**

```bash
git add scripts/fork-overlay/classify.ts scripts/fork-overlay/classify.spec.ts
git commit -m "feat(fork): classify overlay diff"
```

### 任务 3：添加只读 Git 适配器和验证目标检查

**文件：**
- 创建：`scripts/fork-overlay/git-reader.ts`
- 创建：`scripts/fork-overlay/verify.ts`
- 测试：`scripts/fork-overlay/git-reader.spec.ts`
- 测试：`scripts/fork-overlay/verify.spec.ts`

**接口：**
- 产出：`GitReader`、`createGitReader(root: string): GitReader` 和 `verifyOverlay(input: VerifyOverlayInput): Promise<readonly OverlayDiagnostic[]>`。

- [ ] **步骤 1：编写失败的测试**

使用 `mkdtemp`、`git init`、显式用户身份和两个提交创建临时 Git 仓库。证明带空格的路径和 rename 记录能够被正确解析，缺失的提交产生 `upstream-commit-missing`，缺失的 package script 失败，缺失的 Vitest 文件失败。

```ts
export interface GitReader {
  commitExists(commit: string): Promise<boolean>
  listTree(commit: string): Promise<ReadonlySet<string>>
  diff(commit: string): Promise<readonly DiffEntry[]>
}
```

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run scripts/fork-overlay/git-reader.spec.ts scripts/fork-overlay/verify.spec.ts`

预期：失败，因为 Git 适配器和验证器不存在。

- [ ] **步骤 3：实现 Git plumbing 和目标解析**

使用 `execFile('git', args, { cwd, encoding: 'buffer' })`；不要调用 shell。使用 `git ls-tree -r -z --name-only` 加上 `commit` 参数读取 tree 路径。通过两个 NUL 安全调用读取状态和行总数：一个使用 `git diff --name-status -z -M` 加上 `commit` 和 `--`，另一个使用 `git diff --numstat -z -M` 加上 `commit` 和 `--`，然后按能识别 rename 的路径身份连接两者。

只加载一次根 `package.json`。只有当 `scripts[name]` 是非空字符串时，script 目标才有效。只有当每个文件都是仓库相对路径、存在且为普通文件，并且以 `.spec.ts`、`.spec.tsx`、`.e2e.ts` 或 `.test.mjs` 结尾时，Vitest 目标才有效。

- [ ] **步骤 4：运行并确认 GREEN**

运行：`pnpm exec vitest run scripts/fork-overlay/git-reader.spec.ts scripts/fork-overlay/verify.spec.ts`

预期：通过。

- [ ] **步骤 5：提交验证器核心**

```bash
git add scripts/fork-overlay/git-reader.ts scripts/fork-overlay/verify.ts scripts/fork-overlay/git-reader.spec.ts scripts/fork-overlay/verify.spec.ts
git commit -m "feat(fork): verify overlay against git"
```

### 任务 4：交付 CLI 和格式参考，但不激活旧 tree

**文件：**
- 创建：`scripts/verify-fork-overlay.ts`
- 创建：`.fork/README.md`
- 修改：`package.json`
- 测试：`scripts/verify-fork-overlay.spec.ts`

**接口：**
- 产出：`pnpm run verify-fork-overlay`，以及供临时仓库测试使用的可选 `--manifest` 路径。

- [ ] **步骤 1：编写失败的 CLI 测试**

针对有效的 fixture manifest 和包含未覆盖路径的 manifest 启动 CLI。前者断言退出码 `0` 以及 `fork-overlay: PASS`，后者断言退出码 `1` 以及稳定行 `UNCOVERED_PATH path=packages/upstream/file.ts: path is not covered by an overlay entry`。

- [ ] **步骤 2：运行并确认 RED**

运行：`pnpm exec vitest run scripts/verify-fork-overlay.spec.ts`

预期：失败，因为 CLI 不存在。

- [ ] **步骤 3：实现 CLI 和 script**

默认 manifest 是 `.fork/overlay.yaml`。只接受零个参数，或接受后跟一个仓库相对路径的 `--manifest`。按 code、entry id、path 对诊断排序。添加以下根 script：

```json
"verify-fork-overlay": "tsx scripts/verify-fork-overlay.ts"
```

记录每个字段，并在 `.fork/README.md` 中展示一个有效的最小示例。明确说明：只有在 Plan 4 cutover 时才创建 `.fork/overlay.yaml` 并使门禁成为必需项；在此之前，CI 必须只使用 fixture manifest 调用验证器。

- [ ] **步骤 4：运行聚焦验证**

运行：`pnpm exec vitest run scripts/fork-overlay scripts/verify-fork-overlay.spec.ts`

预期：通过。

运行：`pnpm run typecheck:contracts-ready`

预期：通过。

- [ ] **步骤 5：提交 CLI**

```bash
git add .fork/README.md package.json scripts/verify-fork-overlay.ts scripts/verify-fork-overlay.spec.ts
git commit -m "feat(fork): add overlay verification command"
```

### 任务 5：记录架构并完成 Plan 1

**文件：**
- 创建：`.agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.md`
- 创建：`.agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.zh.md`
- 创建：`.agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.i18n.yaml`

**接口：**
- 产出：Plan 4 manifest 条目引用的永久 Agent Note。

- [ ] **步骤 1：编写 Agent Note**

记录四种所有权类别、不可变的上游 SHA、结构化验证目标、exact/tree 匹配、rename 处理、预算计算、陈旧条目失败，以及为何要等迁移后的 tree 再激活。不要引用本实施计划，也不要叙述设计会话。

- [ ] **步骤 2：运行聚焦门禁**

运行：`pnpm exec vitest run scripts/fork-overlay scripts/verify-fork-overlay.spec.ts`

运行：`pnpm run verify-agent-note-format`

运行：`pnpm run verify-translation-pairing`

运行：`git diff --check`

预期：所有命令都对已跟踪的 Plan 1 文件通过。如果仓库级文档门禁报告无关的预先存在的未跟踪文件，记录其准确路径，不要编辑它们。

- [ ] **步骤 3：提交 note**

```bash
git add .agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.md .agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.zh.md .agents/notes/implemented/architecture/2026-08-22-fork-overlay-manifest.i18n.yaml
git commit -m "docs(notes): record fork overlay manifest"
```

## Plan 1 验收

- CLI 测试创建临时仓库，并证明对于完整分类的 fixture，`--manifest .fork/overlay.yaml` 成功。
- 每个必需的失败模式都有确定性测试。
- 真实旧 diff 没有被通配符、临时类别或过大的预算隐藏。
- 在 Plan 4 创建完整文件之前，没有顶层 CI aggregate 要求 `.fork/overlay.yaml`。
