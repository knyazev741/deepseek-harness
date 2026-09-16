---
description: "分支发行版的包职责和配置。"
kind: "package-bundle"
---

# `@knyazevai/dsh-fork-web`

[English](README.md) | 中文

## 概述

可选的 fork Web profile 组合包。将它放在上游 [`dsh-base`](../base/README.zh.md)、[`dsh-web-app`](../web-app/README.zh.md) 和 [`dsh-fork-base`](../fork-base/README.zh.md) 层之后，以添加 fork Workspace UI overlay，同时不修改上游 Web 组合包。

## 目录

- [组合方式](#composition)
- [挂载的能力](#mounted-capability)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="composition"></a>
## 组合方式

该 bundle patch 只包含 insert，并为 [`dsh-fork-ui-workspace-overlay`](../../fork/ui-workspace-overlay/README.zh.md) 挂载 `ui-workspace-overlay` 和 `subagent-model-selection-settings` 两行。三个 Host fork 行仍由 `dsh-fork-base` 所有；本组合包不会复制或重新配置它们。

内置的 `fork-web` profile 模板按顺序挂载 `dsh-base`、`dsh-web-app`、`dsh-fork-base` 和 `dsh-fork-web`。显式的 `web` profile 仍是上游的两层组合，不包含 fork 行；已发布 CLI 的 `dsh web` 别名选择 `fork-web`。

<a id="mounted-capability"></a>
## 挂载的能力

- [`fork-ui-workspace-overlay/`](../../fork/ui-workspace-overlay/README.zh.md) 通过上游 UI 扩展点提供 fork 专属的置顶、未读、来源徽章和会话 ID 操作。“后台”Workspace 视图在后台功能就绪前不被贡献，因此只显示内置的 Workspaces 视图。

本包自身没有运行时 API。后续 profile patch 可以按 id 禁用 `ui-workspace-overlay`，同时保留上游 browser 行和 Host fork 行。

模型选择设置为每次子代理调用启用四条已配置的 Gonka 路由。现有用户设置覆盖这些默认值。

<a id="model-experience"></a>
## 模型体验

### Workspace UI overlay

#### 模型看到的内容

不会添加 prompt section、工具 schema、消息或模型请求字段。所挂载的 `ui-workspace-overlay` 包只改变浏览器呈现和用户操作。

#### Token 影响

直接 Token 影响为零。仅浏览器侧的行操作不会添加模型输入或输出。

#### KV Cache 影响

该 overlay 不改写模型请求或其前缀，因此没有直接的缓存影响。

### 子代理模型选择

#### 模型看到的内容

上游子代理工具允许从已配置的 Gonka 路由列表中逐次选择提供者和模型。子代理启动前会验证选定路由。

#### Token 影响

选择参数的 schema 由上游工具负责。选择其他模型会改变子代理请求路由及其 token 限制。

#### KV Cache 影响

使用其他提供者或模型的子代理不能复用原始路由的提供者缓存。浏览器覆盖层本身不改变 prompt 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 该组合包要求声明的四个层以及 `fork-ui-workspace-overlay` 包位于同一 profile 解析环境中并已安装。
- 显式的 `web` 模板有意不包含该组合包；部署需要选择 `fork-web` profile（或已发布 CLI 的 `dsh web` 别名），或显式组合等价的层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护背景</summary>

将此包适配到上游 API 时，保留针对分支的测试。配置和行为以上文为准。

</details>
