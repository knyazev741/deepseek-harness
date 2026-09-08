# Agent Note: Permanent DSH npm scope

Status: implemented

[English](2026-09-08-knyazevai-dsh-npm-scope.md) | 中文

## Problem

本仓库是发布 DeepSeek Harness 包家族的 fork，同时纳入的 vendored Cordis 框架必须保留上游组织的 npm 身份。单一的 `@deepseek-ai` 包名前缀规则无法区分 fork 自有包与作为 peer 安装的 vendored 包；如果只在产物阶段改名，源码 import、workspace link、锁文件和发布元数据就会描述另一份包图。

## 决策

仓库所有自有的 DSH 包都在 `@knyazevai/dsh*` 下发布。私有 workspace 根包名是 `@knyazevai/dsh-root`，CLI 入口包名是 `@knyazevai/dsh`；包后缀、版本、exports 与仓库 URL 保持不变。九个 vendored Cordis 包继续使用 `@deepseek-ai/cordis`、`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 和 `@deepseek-ai/cordis-plugin-*` 身份。Native Landlock 家族继续使用独立的 `@deepseek-ai/node-addon-*` 名称。

dsh release family 校验 `@knyazevai/dsh` 名称，并以 `@knyazevai/dsh` 作为安装入口；vendor family 独立校验 `@deepseek-ai/` 名称。基线发布与 workspace 约束接受这份显式并集，hygiene 门禁运行 `rescope-dsh:check`，因此过时的 harness token 会在发布前失败。npm CLI 解析例外由 [npm CLI resolution](2026-09-03-npm-cli-resolution.zh.md) 负责，三条序列的发布模型由 [npm release sequences](2026-08-10-npm-release-sequences.zh.md) 负责。

仓库自带的 `rescope-dsh` 命令是上游或仓库同步后的重放机制。它只改写被 Git 跟踪的当前状态包 token，排除 vendored 源码、生成的构建输出、迁移记录和 Agent Note，并支持 check 模式以证明符合条件的旧 DSH token 已全部清除。源码改名后再提交重新生成的锁文件与目录；vendored 包内容和 `github.com/deepseek-ai` 仓库 URL 保持不动。

## 考虑过的替代方案

**让 DSH 与 vendored 包一起发布在 `@deepseek-ai` 下。** 不采用，因为 fork 不拥有这个 namespace，而且单一的宽泛 scope 检查会允许 DSH 包冒充 vendored 身份。

**只在打包或发布时改写名称。** 不采用，因为源码 import、workspace manifest、锁文件解析、生成目录和安装产物检查会描述另一份包图，使 checkout 执行与发布执行使用不同身份。

**用旧 DSH 名称发布 alias 或兼容 wrapper。** 不采用，因为 fork 不应向不拥有的 namespace 发布，而且 alias 会保留不可用或误导性的依赖路径，而不是让包图直接可安装。

## 后果

包图现在有一个 fork 拥有的 DSH 作用域和一个保留的 vendored 作用域。干净 checkout、打包安装和 npm 发布使用相同的包身份；旧的 `@deepseek-ai/dsh*` consumer 不会被静默重定向。

上游同步必须在复制符合条件的当前状态改动后重新运行 `pnpm run rescope-dsh -- --apply`，随后运行 `pnpm run rescope-dsh:check`、重新生成过时的目录、刷新锁文件，并确认受影响的双语 pair。Archived Agent Note 继续作为早期决策的冻结证据。活跃的 implemented Agent Note 排除在 codemod 之外；当其中的当前包身份或其他已交付事实变化时，会有意维护它们。迁移记录仍是历史证据，不会被改写。
