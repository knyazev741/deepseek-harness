# `@deepseek-ai/dsh-fork-web`

[English](README.md) | 中文

可选的 fork Web profile 组合包。将它放在上游 [`dsh-base`](../base/README.zh.md)、[`dsh-web-app`](../web-app/README.zh.md) 和 [`dsh-fork-base`](../fork-base/README.zh.md) 层之后，以添加 fork Workspace UI overlay，同时不修改上游 Web 组合包。

## 组合方式

该 bundle patch 只包含 insert，并为 [`dsh-fork-ui-workspace-overlay`](../../fork/ui-workspace-overlay/README.zh.md) 挂载一行 `ui-workspace-overlay`。三个 Host fork 行仍由 `dsh-fork-base` 所有；本组合包不会复制或重新配置它们。

内置的 `fork-web` profile 模板按顺序挂载 `dsh-base`、`dsh-web-app`、`dsh-fork-base` 和 `dsh-fork-web`。默认的 `web` profile 仍是上游的两层组合，不包含 fork 行。

## 挂载的能力

- [`fork-ui-workspace-overlay/`](../../fork/ui-workspace-overlay/README.zh.md) 通过上游 UI 扩展点提供 fork 专属的置顶、未读、来源徽章和会话 ID 操作。“后台”Workspace 视图在后台功能就绪前不被贡献，因此只显示内置的 Workspaces 视图。

本包自身没有运行时 API。后续 profile patch 可以按 id 禁用 `ui-workspace-overlay`，同时保留上游 browser 行和 Host fork 行。

## 模型体验

### Workspace UI overlay

#### 模型看到的内容

不会添加 prompt section、工具 schema、消息或模型请求字段。所挂载的 `ui-workspace-overlay` 包只改变浏览器呈现和用户操作。

#### Token 影响

直接 Token 影响为零。仅浏览器侧的行操作不会添加模型输入或输出。

#### KV Cache 影响

该 overlay 不改写模型请求或其前缀，因此没有直接的缓存影响。

## 已知限制与延期工作

- 该组合包要求声明的四个层以及 `fork-ui-workspace-overlay` 包位于同一 profile 解析环境中并已安装。
- 默认 `web` 模板有意不包含该组合包；部署需要选择 `fork-web` profile，或显式组合等价的层。
