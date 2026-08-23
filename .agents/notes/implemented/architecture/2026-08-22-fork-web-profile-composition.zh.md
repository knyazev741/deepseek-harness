# Agent Note: Fork Web profile composition

Status: implemented

[English](2026-08-22-fork-web-profile-composition.md) | 中文

## Problem

上游 Web profile 与 fork Host 能力需要分别归属。将 fork 行添加到上游 Web 组合包会让默认浏览器表层自动启用 fork 行为，也会使后续 profile patch 无法区分 Host 行和 Workspace UI overlay。

## Decision

内置的 `fork-web` profile 模板按顺序挂载 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-fork-base` 和 `@deepseek-ai/dsh-fork-web`。`dsh-fork-web` patch 只包含 `ui-workspace-overlay` 的一行 `insert`；会话来源、工作区会话状态和首个结果超时行仍由 `dsh-fork-base` 所有。`web` 模板仍只有两个上游层，不包含 fork 行。

组合测试解析并应用实际的 bundle patch 文件，断言 fork 行唯一且上游 UI 包标识不变。profile 测试固定两个模板元组，避免未来编辑静默地让默认 Web 表层启用 fork，或改变可选层的顺序。

## Alternatives considered

**将 Workspace UI 行添加到 `dsh-web-app`。** 这会失去可选启用行为，因为每个默认 Web profile 都会获得 fork 表现，并让上游组合包拥有 fork 包。

**将所有 fork Host 和 UI 行添加到 `dsh-fork-web`。** 这会重复 `dsh-fork-base` 已拥有的 Host 行；两个层同时组合时可能产生重复 Loader 行。

**用 fork 专属副本替换上游 Web patch。** 这会扩大上游模板差异，并允许上游 UI 标识或配置漂移；单行增量 patch 能保持上游层为唯一权威来源。

## Consequences

默认 `web` profile 保持仅上游组合，而 `fork-web` 成为带有显式包依赖的完整可选组合。部署可以按 id 禁用 UI overlay，而无需改变 Host fork 行。profile 必须能从同一安装或 profile 依赖图解析四个组合包和 UI overlay 包。
