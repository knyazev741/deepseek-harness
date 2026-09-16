# Agent Note: Workspace list contribution points

Status: implemented

[English](2026-08-23-workspace-list-contributions.md) | 中文

## 问题

客户端 Workspace 浏览器需要由 package 自己拥有的通用扩展点，用于筛选标签、会话排序和会话行渲染。浏览器还拥有持久化的 account 排序，因此视图投影不能成为状态输入：如果把筛选后的 snapshot 传给有状态的 tree 或 flat list，状态同步可能只用可见会话 id 重写持久化顺序，并丢弃被排除的会话。

## 决策

`WorkspaceContributionsRuntime` 通过 `ctx.workspaceContributions` 拥有两个排序后的 registry：`registerView` 提供筛选标签，`registerPolicy` 提供有序 comparator。每个 registration 都通过 Cordis effect 创建并返回幂等 disposer；重复 id 和内置的 `workspace.default` view id 都会明确失败。该 service 为 browser hooks 发布不可变 snapshot，callback 异常会传播给 registration 调用方或渲染调用方。

`WorkspaceBrowser` 始终把完整的 upstream session snapshot 传给 `SessionTree` 和 `FlatList`，供持久化 effect 和拖拽提交使用。它们的渲染 derivation 接收当前筛选后的 snapshot。policy comparison 只为该 projection 中有效的 candidate 创建 context，而 stale 或被排除的 id 保留在 upstream order account 中，并由渲染忽略。浏览器拥有 `workspace.default` fallback tab，contributed tab key 与它保持分离。

通用 row slot 是 render contribution point：`workspace.session-row.badges`、`workspace.session-row.status` 和 `workspace.session-row.actions`。浏览器通过中立的 `Menu.extra` 与 `MenuItemButton` primitive，把 action slot 的输出渲染在现有会话菜单中；action owner 会收到 `closeMenu` callback，而 Rename、Fork 和 Archive 仍由浏览器拥有。只有在没有内置 pending、activity、descendant activity 或 completion 状态可见时，status slot 才填充左侧单元格，因此 contribution 不会在浏览器拥有的状态旁边添加第二个指示点。policy 还可以实现可选的 `promote(context)`；被 promote 的 id 会在所有 Workspace 分组上方的合成、默认展开分组中只渲染一次，普通分组会排除这些 id。这个通用 seam 不定义 fork、pin、source、unread 或 background policy。

## 曾考虑的替代方案

**把筛选后的 snapshot 传给每一个 list component。** 拒绝，因为 persistence 和拖拽 effect 会把视图 projection 当成完整 account，从持久化顺序中删除隐藏会话。

**允许每个 contributor 替换 default view。** 拒绝，因为 contributed tab 被移除或 active predicate 不再存在时，浏览器仍需要稳定 fallback；因此 `workspace.default` 保留给浏览器并禁止注册。

**捕获 contributor callback 异常并省略该 contribution。** 拒绝，因为静默省略会隐藏 plugin misconfiguration；predicate 和 comparator 异常在第一次评估它们的渲染点保持可观察。

## 后果

Contributors 可以添加筛选、排序 policy、左侧状态或 action，而不需要导入 browser state 或重复 session traversal。promotion policy 只提供成员资格；合成分组、去重以及从来源 Workspace 行中移除都由 browser 拥有。Registration 生命周期跟随贡献方 Cordis fiber，该 fiber dispose 时发布的 snapshot 也会更新。完整 state snapshot 与筛选后的 render projection 有意分离，因此隐藏会话保留 account 顺序，而可见 candidate 可以重新排序。

## 维护与退出

维护者修改浏览器时必须保留 effect/disposer registration、保留 `workspace.default` id，并保持完整 state input 与筛选 render input 的区分。新的 model-visible 或 fork 相关行为应属于独立的 extension contract，不得加入这些通用点。只有在受支持的 consumer 和 composition 都移除后才能退出该 seam；service、hooks、tests、README pair 与本 note 必须一并移除，且不得在不更新已发布决策的情况下重新使用保留 id。

## 验证

Focused tests 覆盖 registry disposal 和 reserved-id rejection、无 contributor 时的 DOM 与 order 保留、runtime-backed policy ordering、comparator failure 传播，以及通过已应用 client plugin 组合 contributor fiber。Package tests 继续保留现有 tree、flat-list 和 row-slot coverage。
