# @deepseek-ai/dsh-fork-ui-workspace-overlay

[English](README.md) | 中文

这个 fork 所有的浏览器插件提供工作区“后台”视图、GitHub Actions 来源标记，以及三个会话行操作：复制精确的不透明会话 ID、把浏览器本地会话水印标为未读，以及通过 `ctx.remote.forkWorkspaceSessionState` 置顶或取消置顶。

插件使用 `@deepseek-ai/dsh-client-ui-workspace` 的公共 `workspaceContributions` 服务和 `workspace.session-row.badges` / `workspace.session-row.status` / `workspace.session-row.actions` slot。内置的 pending、activity 和 completion 状态只要存在就拥有左侧单元格；未读 contribution 只填充空闲状态，因此同一行不会渲染重复状态点。它不会导入上游私有 UI 模块，也不会修改上游浏览器树。Host 部分有意保持为空；在 web profile 中组合 `./client`、生成的 fork Remote 和会话来源 projection。

未读水印只持久化在 `dsh.fork.workspaceReadWatermarks.v1` 下，并将格式错误的 localStorage 值安全地解析为空映射。当前会话订阅会在每次可见 projection 更新时推进水印；进入会话还会清除显式的“标为未读”状态，而之后的可见更新不会清除该状态。置顶快照仍由服务器负责，使用观测到的 revision 执行 compare-and-set；revision 过期后只刷新一次，绝不自动重放被拒绝的 mutation。

## Model Experience

无，因为仅浏览器侧的覆盖层只改变工作区控件，不提供模型上下文。

#### KV Cache effect

没有影响。该插件不改变模型可见的历史或 prompt 组装。

## Known Limitations and Deferred Work

- 浏览器本地未读状态使用 Host 提供 projection cut 时公共 summary 的 `projectionAsOfSeq`；没有该持久化 sequence 的 summary 不会推进水印。
- 过期 revision 的置顶点击会刷新服务器快照，但要求第二次显式点击，因此浏览器不会针对更新后的服务器状态猜测 mutation。
