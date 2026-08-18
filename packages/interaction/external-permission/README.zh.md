# @deepseek-ai/dsh-external-permission

[English](README.md) | 中文

面向外部 agent 会话（[`external-session`](../../external/external-session/README.md)）的宿主侧权限 bridge。该函数插件在 `ctx.externalSessions` 上注册权限通道，使每个外部 agent 的 [`ExternalPermissionAsk`](../../external/external-session/README.md) 通过 [`ctx.userQuestions`](../user-questions/README.md) 通道触达人类，而人类的选择解析为对应的 [`ExternalPermissionDecision`](../../external/external-session/README.md)。正是宿主责任把 Service Definition 默认的故障关闭 `PERMISSION_UNWIRED` 抛错转化为真实的人类决策。

## 通道

加载插件即在其 fiber 存活期内注册权限回答者。每个 ask 变成一个问题，其选项即 ask 所提供的各选项；返回的决策应用到对应提供方的 ask。dispose 该 fiber（HMR）会注销通道并恢复故障关闭的默认行为。

### 决策映射

ask 的第一个选项解析为 `allowed`，第二个解析为 `rejected`；其它任何选择、空选择（被关闭的问题）、或在受界定的 `timeoutMs` 内无人作答，都解析为 `cancelled`。当未注册任何 user-questions 提供方时，ask 无法得到回答，因此请求会大声失败（`PERMISSION_UNANSWERED`）而不是猜测。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `300000` | 一次 ask 在解析为 `cancelled` 之前的受界定墙钟预算。必须是不大于 `MAX_TIMER_DELAY_MS` 的正安全整数；错误配置在加载时大声失败。 |

## 审计说明

阶段 1 没有 `approval/asked` / `approval/decided` 配对：外部会话没有打开的 DSH turn，因此决策按 ask 应用，而不会对照某个 turn 进行审计。后续阶段会用原生审批 seam 取代此 bridge。见[外部交互式 agent 会话规范说明](../../../.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md)。

## 模型体验

无，因为此 bridge 不会向任何 DSH 会话增加请求上下文 token；它所服务的外部 agent 在父 agent 循环之外驱动。

#### KV Cache 影响

无；bridge 不会向任何请求前缀追加内容。

## 已知限制与暂缓事项

- **需要人类回答者**——当未注册任何 `ctx.userQuestions` 提供方时，ask 会大声失败（`PERMISSION_UNANSWERED`）；没有人类就无法做出决策。
- **阶段 1 被取代**——权限应用路径是 ask-user 通道且没有打开的 DSH turn；后续阶段会用原生审批 seam 取代它。
