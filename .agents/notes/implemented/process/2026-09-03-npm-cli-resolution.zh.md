# Agent Note: npm 从仓库 checkout 解析仓库 CLI

Status: implemented

[English](2026-09-03-npm-cli-resolution.md) | 中文

## 问题

仓库使用 pnpm 作为 workspace 管理器，但从 checkout 运行 `npx @knyazevai/dsh web` 时 npm 也会读取根目录的 `workspaces` 字段。宽泛的 npm glob 同时匹配了 `vendor/CLAUDE.md` 指令符号链接和本地 `apps/cli` 包。npm 随后把 CLI 当作已存在的 workspace 包，却没有创建根目录的 `dsh` shim，因此 `npx` 会交给不存在的 shell 命令；映射 workspace 时，指令符号链接还可能让 npm 以 `ENOTDIR` 失败。

## 决策

根目录的 npm workspace 列表排除 `vendor/CLAUDE.md`，但保留 `apps/cli`。私有根包把 `@knyazevai/dsh: workspace:*` 声明为开发依赖，因此 `pnpm install` 会创建根目录的 `node_modules/@knyazevai/dsh` link 和 `dsh` 可执行 shim。准备好 checkout 后，从 checkout 运行 `npx @knyazevai/dsh web` 会使用本地 CLI 及其 workspace 插件，不会访问 npm。权威的 pnpm workspace 列表保持不变。

[DSH npm 作用域 Agent Note](2026-09-08-knyazevai-dsh-npm-scope.zh.md) 负责永久的 `@knyazevai` 与 `@deepseek-ai` 包家族分工；本 Note 负责该分工下 npm workspace 解析的例外。

用于发布的 `@knyazevai/dsh` 包 manifest 在自身字段中声明仓库的 Node 引擎范围 `^22.19.0 || >=24.0.0`。它的 `bin.mjs` 包装层在包从本 checkout 解析时通过 `tsx` 运行仓库的 `scripts/repo-dsh.ts`，在 checkout 外部则回退到包内的 `lib/bin.js`。根目录 README 配对文件在 npm 命令旁声明相同的前置条件。

## 曾考虑的替代方案

- **从 npm workspace 匹配中排除 `apps/cli`：** `npx` 会退回 registry 包，不会运行 checkout 中的本地构建或插件。
- **删除根目录的 `workspaces` 字段：** 这会避免 npm 发现 workspace，但会破坏读取根 manifest 来枚举 DSH 包的仓库工具；同时 pnpm 已经有独立的权威 workspace 文件。
- **让 `npx` 执行另一套源码包装层：** 这会重复 CLI 入口，而且在 checkout 能解析 workspace 依赖之前仍需要 `pnpm install`；根包 link 可以复用现有 CLI 入口。

## 后果

- 执行 `pnpm install` 后，从 checkout 运行 `npx @knyazevai/dsh web` 会使用 checkout 中的 CLI 和本地插件；在 checkout 外部，`npx` 仍正常解析 registry 包。
- npm 专用的排除项只移除 vendor 指令符号链接，完整的 pnpm workspace 和本地 CLI 包仍然可用。
- 用户必须使用 Node.js 22.19+ 或 24+；下一次 npm 发布可以提前报告引擎版本不匹配，而不是让 CLI 稍后因为缺少 Node API 才失败。

## 测试

- npm workspace mapper 解析出 251 个 workspace，同时排除 `@knyazevai/dsh` 和 `vendor/CLAUDE.md`。
- 仓库 CLI 的 metadata 把 `dsh` 映射到 `bin.mjs`，并且其 checkout 源码路径在没有 `apps/cli/lib` 时也能工作。
- 当前 registry tarball 保留 `dsh` 到 `lib/bin.js` 的映射并包含该可执行文件。
- workspace 安装后，`npx --no-install @knyazevai/dsh --version` 和 `npx @knyazevai/dsh --version` 都返回 `0.1.1-rc.2`。
- `pnpm dsh --version`、`pnpm run verify-dsh-package-licenses`、README 配对检查和相对链接校验均通过。
