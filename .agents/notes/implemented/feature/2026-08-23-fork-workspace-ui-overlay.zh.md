# Agent Note：Fork 工作区 UI 覆盖层状态与生命周期

状态：已实现

[English](2026-08-23-fork-workspace-ui-overlay.md) | 中文

## 问题

fork 需要后台筛选、来源标记、本地未读标记和服务器置顶操作，但不能修改上游 Workspace 浏览器，也不能导入其私有实现模块。

## 决策

覆盖层使用公共 `workspaceContributions` 服务和两个公共 Workspace 会话行 slot。后台视图包含运行中的会话，以及 projection 值恰好为 `github-actions` 的会话。来源标记和三个操作使用稳定 id 注册为独立 list 条目。置顶策略先分出置顶行，并在每个分区内返回零，使上游顺序保持权威。

未读水印使用版本化浏览器 key `dsh.fork.workspaceReadWatermarks.v1`；解析严格，格式错误时回退为空映射。置顶状态保留在独立的内存快照中，只接受 Host 成功返回的 Remote 结果。compare-and-set 过期时只刷新一次列表，不会重放 mutation；下一次 mutation 必须由用户再次显式点击。

所有注册项、当前会话订阅、本地 store 和 locale dictionary 都由 client fiber 的 effect 管理，因此销毁会同时移除 contribution、slot、订阅和命名空间。

## 结果

公共 session summary 不要求 sequence 字段。若 adapter 提供可选 sequence，未读标记优先使用它；没有 sequence 时使用 `updatedAt` 作为单调回退值。覆盖层不增加模型可见或 transcript 状态。
