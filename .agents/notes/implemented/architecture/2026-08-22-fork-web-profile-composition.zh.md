# Agent Note: Fork Web profile composition

Status: implemented

[English](2026-08-22-fork-web-profile-composition.md) | 中文

## Problem

上游 Web profile 与 fork Host 能力需要分别归属。将 fork 行或可移植 provider 默认值添加到上游组合包会让默认浏览器表层自动启用 fork 行为，也会使后续 profile patch 无法区分 Host 行和 Workspace UI overlay。

## Decision

内置的 `fork-web` profile 模板按顺序挂载 `@knyazevai/dsh-base`、`@knyazevai/dsh-web-app`、`@knyazevai/dsh-fork-base` 和 `@knyazevai/dsh-fork-web`。`dsh-fork-web` patch 只包含 `ui-workspace-overlay` 的一行 `insert`；`dsh-fork-base` 先插入会话来源、工作区会话状态和首个结果超时行，再以可移植的 Knyazev AI 默认值覆盖上游 `llm-pi-ai` 与 `agent-default-model` config，并选择 `knyazev-ai/deepseek-v4-flash`。provider 只保存外部的 `KNYAZEV_AI_API_KEY` 引用，用户 settings 层仍位于这些 composition 默认值之上。`web` 模板仍只有两个上游层，不包含 fork 行。仓库本地的 `pnpm dsh web` launcher 与已发布 CLI 的 `dsh web` 别名都会选择 `fork-web`；显式的 `pnpm dsh --profile web` 仍是仅上游模板。

CLI 将两个 fork 组合包声明为安装依赖，因此 `healProfilesModuleFallback` 会遍历它们的传递插件闭包；空的 `$DSH_HOME` 无需 profile 本地链接或已有 settings 文档即可解析 `fork-web`。built CLI dump 回归测试覆盖该 clean-install 路径；由于 config dump 不会计算运行时 settings seam，另一个 Loader 测试单独覆盖 settings 文件对 provider/default 的部分叠加。

组合测试解析并应用实际的 bundle patch 文件，断言 fork 行唯一、可移植模型／默认选择、没有 secret literal，以及后续按 id 替换的行为。profile 测试固定两个模板元组，避免未来编辑静默地让默认 Web profile 启用 fork，或改变可选层的顺序。仓库 launcher 测试运行 `pnpm dsh web --dump-default-config` 并要求存在 fork bundle；built CLI 测试从空 harness home 运行 `fork-web --dump-default-config`。Loader 测试写入部分 settings 文档并断言用户值覆盖可移植 base。

## Alternatives considered

**将 Workspace UI 行添加到 `dsh-web-app`。** 这会失去可选启用行为，因为每个默认 Web profile 都会获得 fork 表现，并让上游组合包拥有 fork 包。

**将所有 fork Host 和 UI 行添加到 `dsh-fork-web`。** 这会重复 `dsh-fork-base` 已拥有的 Host 行；两个层同时组合时可能产生重复 Loader 行。

**用 fork 专属副本替换上游 Web patch。** 这会扩大上游模板差异，并允许上游 UI 标识或配置漂移；单行增量 patch 能保持上游层为唯一权威来源。

**只将 Knyazev AI 默认值保留在用户 settings 文档中。** 这样全新的 `fork-web` home 会保持 dormant，或依赖已有的 `~/.dsh/settings.yaml`，发行版无法提供可复现的模型路由。

**将 Knyazev AI 密钥提交到组合包。** 这会把发行版默认值变成仓库机密，使轮换或按部署配置凭据不安全；组合包只携带 `apiKeyEnv` 引用。

## Consequences

显式的 `web` profile 模板保持仅上游组合，而 `fork-web` 成为带有 CLI 安装依赖的完整可选组合，即使没有预先存在的 settings 文档也提供可移植的 Knyazev AI 路由。已发布 CLI 的 `dsh web` 别名选择该 fork 组合。用户 settings 可以覆盖 provider 字段或 default model，后续 profile、home、`--patch` 层可以整体替换目标插件 config。缺少 `KNYAZEV_AI_API_KEY` 时仍是外部凭据失败，而不是已提交的值。部署可以按 id 禁用 UI overlay，而无需改变 Host fork 行。该 profile 的四个组合包和 UI overlay 包必须从同一安装依赖图解析；树外 profile 组合包仍使用 profile 自己由 pnpm 管理的目录。
