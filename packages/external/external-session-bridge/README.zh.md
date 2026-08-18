# @deepseek-ai/dsh-external-session-bridge

[English](README.md) | 中文

面向外部交互式 agent 会话（[`external-session`](../external-session/README.md)）的宿主侧 bridge 驱动。该函数插件把外部会话注册表（`ctx.externalSessions`）连接到以外部模式创建的真实宿主会话上。当某个会话以持久化头部 `mode` 命名了某个已注册的外部提供方进入宿主存储时，本驱动在该预保留的会话 id 上启动该提供方的实时会话；提供方通过其每会话 bridge 写入的活动，会以仅日志的 `external/*` 事件落入所属会话的持久化日志。本驱动还会注册 [external-transcript 投影单元](../../session/session-projection/README.md)，使回放与客户端渲染无需重新遍历原始事件日志；并在会话关闭时销毁提供方的进程树。

模式感知的创建决策（在持久化头部上打上 `mode` 标记，并对外部模式创建*不带*原生 Agent 的会话）位于会话创建网关 [`dsh-host-apiproxy`](../../host/apiproxy/README.md)。本插件只对已经打上标记的会话作出反应，因此它可随 external-session 家族挂载到任何组合中。

## 生命周期

加载插件即在其 fiber 存活期内注册投影并向两个生命周期事件作出反应：

- `session/created` ——当会话头部 `mode` 命名了某个已注册提供方（且不是原生 Agent 默认的 `dsh`）时，驱动在该会话 id 上启动该提供方。若会话以没有已注册提供方的模式创建，在创建时会大声失败（驱动拒绝让会话悬空）。
- `session/disposed` ——驱动为它启动过的会话销毁提供方，从而拆除外部进程树。

提供方 `start` 被拒绝属于无法回退的异步「发布后失败」，因此它会落到类型化的宿主事件 `external/session-bridge/error` 上大声暴露，而不是被静默丢弃。

## 模型体验

父级 `dsh` 会话无影响：这里投影的活动是作为仅日志 `external/*` 事件记录的外部 agent 活动，不会到达任何父级模型请求。它所驱动的外部 agent 位于父级 agent 循环之外。

#### KV Cache 影响

无；驱动不会向任何请求前缀追加内容。

## 已知限制与暂缓事项

- **实时帧 delta 路由属于客户端阶段**——提供方 bridge 的 `streamDelta` 由 `external-session` 服务所有，此处未接入帧通道；实时增量 delta 及其 UI 座位属于后续（客户端）阶段。
- **仅创建时**——本驱动只对新建会话作出反应；重启时对冷外部会话的重新挂接（恢复先前已启动的外部会话）属于后续阶段。
