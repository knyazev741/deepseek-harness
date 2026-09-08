# KnyazevAI npm 作用域迁移实施计划

[English](2026-09-08-knyazevai-npm-scope.md) | 中文

> **面向智能体工作者：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐任务实施此计划。使用复选框（`- [ ]`）语法跟踪步骤。

**目标：** 以 `@knyazevai/dsh*` 发布并运行完整的 DSH 包族，同时让 vendored Cordis 包继续使用 `@deepseek-ai`，并保留压缩（compaction）、超时恢复（timeout recovery）和 client bundle 修复。

**架构：** 仓库自有的幂等 codemod 会改写 Git 跟踪文件中的 DSH 包前缀，并在 check 模式下拒绝后续 drift。release family 校验明确管理两个允许的 npm 前缀：DSH 使用 `@knyazevai/dsh`，vendor 包保留 `@deepseek-ai`。迁移只在源码中应用一次，记录在 implemented Agent Note 中，版本设为 `0.1.5`，然后在发布前从 packed tarball 验证。

**技术栈：** TypeScript ESM、Node.js 的 `child_process` 与 `fs`、pnpm workspace、Vitest、tsdown、GitHub Actions、npm。

**规范：** `docs/superpowers/specs/2026-09-08-knyazevai-npm-scope-design.zh.md`

## 全局约束

- 只重写包名前缀 `@deepseek-ai/dsh` 为 `@knyazevai/dsh`；不要改变仓库 URL 或 vendored `@deepseek-ai/cordis`、`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis-plugin-*` 名称。
- codemod 只处理 Git 跟踪的文本文件，并排除 `vendor/`、`.agents/notes/`、`docs/superpowers/specs/`、`docs/superpowers/plans/`、生成的构建输出、依赖树以及自身的源前缀声明。
- 有 npm 身份或发布归属的 active Agent Note 要有意更新；archived Agent Note 必须逐字节保持不变。
- 每个 DSH release member 和 private DSH workspace package 都使用相应的 `@knyazevai/dsh*` 名称与共享版本 `0.1.5`。
- CLI 包名和 installed release entry 必须准确为 `@knyazevai/dsh`；tag 仍为 `dsh-v0.1.5`。
- 迁移保持源码级且永久；不要添加 alias、wrapper、postinstall 下载、GitHub tarball dependency 或 artifact-only rewrite。
- 保留此前实现的 50% 压缩阈值、强制首个分片超时压缩/continuation，以及 generated-client runtime import 修复。
- 保持实现最小，并单独报告无关的 repository-wide baseline failure。

---

### 任务 1：确定性的 DSH rescope 命令

**文件：**
- 创建：`scripts/rescope-dsh.ts`
- 创建：`scripts/rescope-dsh.spec.ts`
- 修改：`package.json`

**接口：**
- 输入：来自 `git ls-files -z` 的 Git 跟踪文件列表，以及从 `import.meta.dirname` 推导出的仓库根目录。
- 输出：`eligibleDshRescopePath(path: string): boolean`、`rescopeDshText(text: string): string`，以及通过 `pnpm run rescope-dsh` 使用的 `--apply`、`--check` 或 dry-run CLI 模式。

- [ ] **步骤 1：为路径资格判断和字面替换编写失败的单元测试**

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

- [ ] **步骤 2：运行聚焦测试，并确认它因模块不存在而失败**

运行：`pnpm exec vitest run scripts/rescope-dsh.spec.ts`

预期：解析 `./rescope-dsh.ts` 时 FAIL。

- [ ] **步骤 3：实现最小 tracked-file codemod**

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

CLI 只能解析 `--apply` 和 `--check`，拒绝未知选项，从 `git ls-files -z` 读取路径，并报告内容将发生变化的每个符合条件的文件。dry-run 在报告后成功退出。`--apply` 写入发生变化的文件，然后证明第二次 pass 没有变化。`--check` 在任何符合条件的文件仍包含 source prefix 时失败。只对上述文本扩展名以 UTF-8 读取和写入。

- [ ] **步骤 4：添加根脚本**

```json
"rescope-dsh": "tsx scripts/rescope-dsh.ts",
"rescope-dsh:check": "tsx scripts/rescope-dsh.ts --check"
```

- [ ] **步骤 5：运行聚焦测试和 CLI 行为检查**

运行：`pnpm exec vitest run scripts/rescope-dsh.spec.ts`

预期：PASS。

运行：`pnpm run rescope-dsh`

预期：退出码为 0，列出符合条件的文件，并且不修改这些文件。

运行：`pnpm run rescope-dsh:check`

预期：退出码非 0，并在 Task 2 应用迁移前列出 stale eligible files。

- [ ] **步骤 6：提交命令与测试**

```bash
git add package.json scripts/rescope-dsh.ts scripts/rescope-dsh.spec.ts
git commit -m "build: add deterministic dsh scope migration"
```

---

### 任务 2：应用包身份迁移并执行作用域分离

**文件：**
- 机械修改：`pnpm run rescope-dsh` 报告的每个 tracked file。
- 有意修改：`scripts/release/families.ts`、`scripts/release/families.spec.ts`、`scripts/check-workspace-constraints.ts`、`scripts/publish-npm-baseline.ts`、`scripts/run-gates.ts`、`.github/workflows/release.yml`、`.github/workflows/release-publish.yml`、`AGENTS.md`、`docs/rescope.md`，以及仍假定所有包以 `@deepseek-ai/` 开头的任何 generator 或 test。
- 创建：`.agents/notes/implemented/process/2026-09-08-knyazevai-dsh-npm-scope.md`
- 创建：`.agents/notes/implemented/process/2026-09-08-knyazevai-dsh-npm-scope.zh.md`
- 创建：`.agents/notes/implemented/process/2026-09-08-knyazevai-dsh-npm-scope.i18n.yaml`
- 有意修改：`.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md`、`.agents/notes/implemented/process/2026-08-10-npm-release-sequences.zh.md`、`.agents/notes/implemented/process/2026-08-10-npm-release-sequences.i18n.yaml`、`.agents/notes/implemented/process/2026-09-03-npm-cli-resolution.md`、`.agents/notes/implemented/process/2026-09-03-npm-cli-resolution.zh.md`、`.agents/notes/implemented/process/2026-09-03-npm-cli-resolution.i18n.yaml`。
- 修改生成的 lock 和配对记录：`pnpm-lock.yaml` 以及每个发生机械变更的双语文档对应的 `.i18n.yaml`。

**接口：**
- 输入：Task 1 的 `pnpm run rescope-dsh -- --apply` 和 `pnpm run rescope-dsh:check` 命令。
- 输出：`@knyazevai/dsh*` 下的 DSH workspace 名称和引用；`ReleaseFamily.packagePrefix: string`；分别接受 DSH 和 vendor 作用域的 release 校验；调用 `rescope-dsh:check` 的 hygiene 门禁。

- [ ] **步骤 1：为分离 npm 作用域添加失败的 release-family 测试**

将 DSH fixture 和预期更新为 `@knyazevai/dsh*`，让 vendor fixture 继续使用 `@deepseek-ai/*`，并加入以下断言：

```ts
expect(releaseFamily('dsh').installedEntry).toEqual({
  packageName: '@knyazevai/dsh',
  binPath: 'lib/bin.js',
})
expect(() => releaseFamily('dsh').members(dshFixtureRoot)).toThrow(/must name an @knyazevai\/dsh package/)
expect(() => releaseFamily('vendor').members(vendorFixtureRoot)).toThrow(/must name an @deepseek-ai package/)
```

运行：`pnpm exec vitest run scripts/release/families.spec.ts`

预期：FAIL，因为 release base class 仍强制使用单一 `@deepseek-ai/` 前缀，installed entry 仍使用旧 CLI 名称。

- [ ] **步骤 2：为每个 release family 提供自己的包前缀**

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

让 root-package exclusion 与 family 保持一致，将其值改为 `@knyazevai/dsh-root`。更新 baseline publication 和 workspace constraints，使其接受明确的 union `@knyazevai/dsh* | @deepseek-ai/<vendored-name>`，而不是宽泛且容易误收包的作用域假设。

- [ ] **步骤 3：应用机械源码迁移**

运行：`pnpm run rescope-dsh -- --apply`

预期：每个报告的 tracked current-state file 都从 source DSH prefix 改为 target DSH prefix；`vendor/`、`.agents/notes/` 和迁移文档不变。

- [ ] **步骤 4：修复重命名后的生成/当前元数据**

运行：`pnpm install --lockfile-only`

预期：lockfile imports 和 workspace package identities 使用 `@knyazevai/dsh*`，而 vendored resolutions 仍使用 `@deepseek-ai`。

对于每个发生变化的双语 Markdown 配对，同时机械更新两侧，并使用 `pnpm run verify-translation-pairing --write <english-path>` 记录准确的配对。重新生成其 generator 嵌入包名的 checked-in catalogs，然后按文档化的 generator workflow 更新 Chinese counterpart 和 pairing records。

- [ ] **步骤 5：记录永久的 fork 作用域决策**

创建新的 implemented process Agent Note，包含必需的 `Problem`、`Decision`、`Alternatives considered` 和 `Consequences` sections。它必须说明 DSH 发布到 `@knyazevai`、vendor 包留在 `@deepseek-ai`、codemod 是 upstream-sync replay mechanism，并拒绝 alias 或 artifact-only rewrite。从两个现有 active note 交叉链接，并更新它们当前的 command/package facts，不重写 archived note。

运行：`pnpm run verify-translation-pairing --write .agents/notes/implemented/process/2026-09-08-knyazevai-dsh-npm-scope.md .agents/notes/implemented/process/2026-08-10-npm-release-sequences.md .agents/notes/implemented/process/2026-09-03-npm-cli-resolution.md`

预期：三个指定配对全部确认一致。

- [ ] **步骤 6：将 drift check 加入 hygiene 门禁并测试迁移后的状态**

将 `rescope-dsh:check` 添加到 hygiene 门禁中 `rescope-vendor:check` 的旁边，保持有序命令集合的相邻位置。

运行：`pnpm run rescope-dsh:check`

预期：PASS，且没有 stale eligible DSH prefix。

运行：`pnpm exec vitest run scripts/rescope-dsh.spec.ts scripts/release/families.spec.ts scripts/check-workspace-constraints.spec.ts scripts/publish-npm-baseline.spec.ts`

预期：PASS。

运行：`pnpm run constraints`

预期：分离的 DSH/vendor 作用域通过检查。

运行：`git diff --check`

预期：PASS。

- [ ] **步骤 7：提交源码迁移**

```bash
git add -A
git commit -m "build: move dsh packages to knyazevai scope"
```

---

### 任务 3：将版本设为 0.1.5 并验证可发布产物

**文件：**
- 通过 release command 修改：`package.json`、每个 DSH family 的 `package.json`、private DSH workspace manifests 和 `pnpm-lock.yaml`。
- 无需修改源码即可验证：official build output 和 release command 的临时/输出目录下的 tarball。

**接口：**
- 输入：Task 2 完整的 `@knyazevai/dsh*` source graph，以及现有 `release:dsh`、`release:verify`、`release:pack` 和 `release:verify-packed-install` 命令。
- 输出：共享的 DSH 版本 `0.1.5`、release-ready commit，以及 packed CLI 报告 `0.1.5` 的本地证据。

- [ ] **步骤 1：在提升版本前验证行为修复**

运行：

```bash
pnpm exec vitest run packages/compaction/compaction-basic/tests/compaction-basic.spec.ts packages/fork/llm-first-chunk-timeout/tests/timeout.spec.ts scripts/client-bundle-purity.spec.ts
```

预期：压缩阈值、超时恢复和 generated-client import 行为均 PASS。

运行：

```bash
pnpm exec vitest run --config vitest.snapshot.config.ts examples/headless-agent/tests/headless.snapshot.ts -t 'forces low-pressure first-chunk compaction'
```

预期：PASS；快照记录强制压缩后紧接 continuation。

- [ ] **步骤 2：将完整 DSH family 升级到 0.1.5**

运行：`pnpm run release:dsh -- 0.1.5`

预期：该命令将共享的 `0.1.5` 版本写入 root、可发布的 DSH 成员、private DSH 包和 lockfile，并创建 release commit。

- [ ] **步骤 3：构建并验证 release family**

运行：`pnpm run build:official`

预期：PASS，并生成完整的 Host 和 Web 产物。

运行：`pnpm run release:verify -- --family dsh`

预期：PASS；每个 DSH 成员都命名为 `@knyazevai/dsh*`、可发布、版本为 `0.1.5`，并且可以表示 dependency-first 顺序。

- [ ] **步骤 4：打包 DSH 和 vendor 依赖，然后安装这些精确字节**

使用空的输出目录，分别对 `dsh` 和 `vendor` family 运行 repository 的 release pack command。使用两个目录运行 `release:verify-packed-install`，使 npm 只解析生成的 tarball。

预期：所有 tarball 都能打包；安装到空消费方成功；packed `@knyazevai/dsh` 可执行文件报告 `0.1.5`。

- [ ] **步骤 5：运行最终本地发布检查**

运行：`pnpm run typecheck`

预期：PASS。

运行：`git diff --check`

预期：PASS。

运行：`git status --short`

预期：没有未提交的源码变更；构建和打包残留要么被忽略，要么仅通过仓库的安全清理路径移除。

- [ ] **步骤 6：将发布证据交给控制器**

报告准确的命令和结果。完成整个分支评审后，控制器负责外部操作：推送 branch/commit、创建 `dsh-v0.1.5`、dispatch 受保护的 publication workflow、等待完成，并验证 `npm view @knyazevai/dsh version` 以及 `npx @knyazevai/dsh@0.1.5 --version`。
