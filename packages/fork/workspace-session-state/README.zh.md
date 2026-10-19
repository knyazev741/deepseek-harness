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

服务等待 `settings` 和 `workspaceRegistry`。旧 Settings 命名空间 `fork-workspace-session-state` 接受 `{ pins: { sessionIds: string[] } }`；适配器按保存的顺序将已知且未归档的会话导入原生 Workspace 持久化，然后清空旧列表。

<a id="host-service-and-remote"></a>
## Host 服务与 Remote

Host 服务通过 `ctx.forkWorkspaceSessionState` 提供。生成的 Remote 命名空间是 `forkWorkspaceSessionState`，只包含以下方法：

- `list()` 返回 `{ revision, pinnedSessionIds }`。
- `setPinned({ sessionId, pinned, expectedRevision })` 返回成功值，或类型化的 `revision-conflict` / `session-not-in-workspace` 结果。

`workspaceRegistry.list()` 决定新置顶准入。原生 Workspace 操作负责持久化与排序，包括归档时移除置顶。适配器调用串行执行；观察到的 revision 在本进程内检测过期调用，重启后重置。原生 UI 操作直接使用 Workspace API。

生成的 `./remote` 和 `./typert` 构件由 Host 构建产生。API Proxy 保持不变；Client 组装可通过 `packages/api/remotes` 挂载此命名空间。

<a id="model-experience"></a>
## 模型体验

无。本服务存储 Host 工作区状态，不产生 prompt、工具或模型请求内容。

#### KV Cache 影响

无；置顶状态不会进入模型可见输入。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 本包不提供 UI。原生 Workspace 行操作展示并编辑置顶。
- 导入时丢弃旧列表中未知或已归档的置顶。
- 列表属于当前组合的工作区注册表全局范围；Remote 有意不包含 `workspaceId` 字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护背景</summary>

将此包适配到上游 API 时，保留针对分支的测试。配置和行为以上文为准。

</details>
