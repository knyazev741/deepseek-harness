---
description: "分支发行版的包职责和配置。"
kind: "package-reference"
---

# @knyazevai/dsh-fork-workspace-session-state

[English](README.md) | 中文

## 概述

为当前工作区注册表所附会话提供一个有序共享置顶列表的 Host 服务。本包为私有且选择性启用；普通 profile 不会加载它。

## 目录

- [组合](#composition)
- [Host 服务与 Remote](#host-service-and-remote)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="composition"></a>
## 组合

```yaml
- id: fork-workspace-session-state
  name: '@knyazevai/dsh-fork-workspace-session-state'
```

服务等待 `settings` 和 `workspaceRegistry`。它使用的 Settings 命名空间严格为 `fork-workspace-session-state`，持久化值为 `{ pins: { sessionIds: string[] } }`。Settings 描述符 revision 是服务暴露的唯一 revision。

<a id="host-service-and-remote"></a>
## Host 服务与 Remote

Host 服务通过 `ctx.forkWorkspaceSessionState` 提供。生成的 Remote 命名空间是 `forkWorkspaceSessionState`，只包含以下方法：

- `list()` 返回 `{ revision, pinnedSessionIds }`。
- `setPinned({ sessionId, pinned, expectedRevision })` 返回成功值，或类型化的 `revision-conflict` / `session-not-in-workspace` 结果。

`workspaceRegistry.list()` 是新置顶准入判定的权威来源。置顶只追加一次，取消置顶保留其余置顶项的相对顺序，幂等请求不会写入 Settings。会话离开注册表后，包括归档或 Workspace 删除后，已有持久置顶仍可随时移除。修改操作会串行执行，并使用 Settings 描述符 revision 做 compare-and-set。过期请求会在幂等判断前检查；竞争性的 Settings 写入会返回同样的类型化 revision 冲突。工作区成员关系后续变化时，已持久化的置顶项会一直保留，直到显式取消置顶。

生成的 `./remote` 和 `./typert` 构件由 Host 构建产生。API Proxy 保持不变；Client 组装可通过 `packages/api/remotes` 挂载此命名空间。

<a id="model-experience"></a>
## 模型体验

无。本服务存储 Host 工作区状态，不产生 prompt、工具或模型请求内容。

#### KV Cache 影响

无；置顶状态不会进入模型可见输入。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 本包不提供 UI。未来的 Client 贡献可以通过生成的 Remote 展示并编辑列表。
- 成员关系只在新置顶准入时检查。工作区注册表变化时，不会自动清理已有置顶项，但仍可显式取消置顶。
- 列表属于当前组合的工作区注册表全局范围；Remote 有意不包含 `workspaceId` 字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护背景</summary>

将此包适配到上游 API 时，保留针对分支的测试。配置和行为以上文为准。

</details>
