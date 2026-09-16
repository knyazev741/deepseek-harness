# Agent Note：Fork 工作区 UI 覆盖层状态与生命周期

状态：已实现

[English](2026-08-23-fork-workspace-ui-overlay.md) | 中文

## 问题

fork 需要来源标记、本地未读标记和服务器置顶操作，但不能修改上游 Workspace 浏览器，也不能导入其私有实现模块。在功能就绪前不接入扁平的后台 WorkSpace 视图，因此内置的 WorkSpaces 视图是唯一的会话浏览面。

## 决策

覆盖层使用公共 `workspaceContributions` 服务和三个公共 Workspace 会话行 slot。它不接入任何 `fork.background` WorkSpace 视图；在功能就绪前不提供扁平的 Background 列表。来源标记仍是独立 list 条目，一个 status 条目只在会话空闲且未选中时根据过期的 read watermark 渲染绿色完成点，另一个 action 条目则把复制会话 ID、标为未读和置顶渲染到浏览器拥有的会话菜单中。浏览器拥有的 pending、activity 和 completion 状态优先于未读条目，因此 completion 与 watermark 状态重叠时仍只渲染一个指示点。置顶状态同时贡献稳定 comparator 和 promotion predicate；置顶会话只在所有 Workspace 上方共享的 `Pinned` 分组中渲染一次，未置顶会话保留在来源 Workspace 的顺序中。

未读水印使用版本化浏览器 key `dsh.fork.workspaceReadWatermarks.v1`；解析严格，格式错误时回退为空映射。进入会话会清除显式未读状态，而之后在该当前会话中观察到的每次 projection 更新都会推进水印，但不会清除新的显式标记。置顶状态保留在独立的内存快照中，只接受 Host 成功返回的 Remote 结果。compare-and-set 陈旧时会执行一次权威列表刷新，并重放一次相同的显式意图。由于 Settings revision 会随 Host 进程重启，该刷新可以用较低的 Host revision 替换较高的浏览器 revision；普通的延迟列表响应仍保持单调，不能替换较新的已接受 mutation。

所有注册项、当前会话订阅、本地 store 和 locale dictionary 都由 client fiber 的 effect 管理，因此销毁会同时移除 contribution、slot、订阅和命名空间；覆盖层移除后，promotion 和未读状态也会从上游 browser 消失，而不会改变 browser 自己拥有的状态。

## 考虑过的替代方案

**使用 `updatedAt` 或私有的 `lastSeq` adapter。** 这两种方案都被拒绝，因为 wall-clock 元数据不是持久化日志 sequence，私有结构字段也不是公共 client contract。现在 client runtime 将 Host projection cut 作为 `SessionSummary.projectionAsOfSeq` 暴露；缺少该字段时，覆盖层保持水印不变。

**revision 冲突后要求再次点击。** 该方案被拒绝，因为第一次点击已经表达一个精确的置顶意图，而冲突和刷新提供了安全重试所需的权威状态。把该意图变成无操作，会让每次 Host 重启后的浏览器标签页停留在前一个进程的 revision 上。

## 结果

client runtime 将每个列表行观察到的最高 Host projection cut 作为 `SessionSummary.projectionAsOfSeq` 传递，并与 `updatedAt` 分离。覆盖层使用该持久化 sequence 推进未读标记，字段缺失时不臆造 sequence，并在延迟读取到达时按 revision 保持置顶快照安全。覆盖层不增加模型可见或 transcript 状态。浏览器启动路径中的客户端插件收不到 loader 的 `config`，因此无法通过 cordis.yml 的 `config` 标志隐藏 Background 视图；该移除是代码层面的。重新加入该视图意味着从覆盖层重新接入它，并从 git 历史中恢复 `BackgroundView`。
