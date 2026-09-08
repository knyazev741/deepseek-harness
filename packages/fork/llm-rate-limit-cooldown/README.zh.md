# @knyazevai/dsh-fork-llm-rate-limit-cooldown

[English](README.md) | 中文

Fork 拥有的 LLM 插件，在 `dsh-llm-retry` 的有界预算法尽后让受 provider 限制的请求保持存活：它等待一个较长的冷却时间并返回一次重试动作，让 agent loop 重新尝试同一个请求，而不是让超出快速退避的持久 `429`（限流）或上游 `5xx`（`502`/`503`，provider 宕机）直接结束本轮回合。

## 组合方式

```yaml
- id: fork-llm-rate-limit-cooldown
  name: '@knyazevai/dsh-fork-llm-rate-limit-cooldown'
  config:
    cooldownMs: 600000
```

该插件依赖 `agents`，并监听 `agent/request-error` waterfall。它是选择性启用的，普通 profile 不会挂载；Host fork 组合包会与 `dsh-llm-retry` 一起挂载它。

## 有界预算法尽后的升级

`dsh-llm-retry` 负责对瞬时失败进行快速指数退避，直到每个 provider 的 `retryPolicy.maxRetries`；对 `mode: always` 则无界地重试所有失败。本插件只扩展有界（`mode: normal`）路径：

- 仅当 `failure.code` 位于 `retryableCodes`（默认 `['RATE_LIMIT', 'SERVER', 'QUOTA', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR']`：`RATE_LIMIT` 是 HTTP `429`，`SERVER` 是上游 5xx 如 `502`/`503`，`QUOTA` 是配额耗尽，`TIMEOUT` 是请求超时，`TRANSPORT` 是流/连接截断，`PI_AI_ERROR` 是 pi-ai provider 的 catch-all）且该请求在对应 `turn`/`step`/`provider` 上的持久 `llm/retry` 链已达 provider 的 `maxRetries` 时，它才接管该失败。
- 其他情况——不同代码、无界/缺失策略、或预算法尽——都会通过 `next()` 委托，所有权仍归 `dsh-llm-retry` 或后续监听器。

接管后等待 `cooldownMs`（默认 `600000` = 10 分钟，非零且不超过 Node 可靠定时器上限 `2147483647`），该等待可被回合 `signal` 和插件销毁取消，然后返回 `{ kind: 'retry' }`。loop 随即重新运行同一请求；若再次受限，插件会再次接管并再次等待——因此持续性 `429`、上游 `5xx`、配额、超时或传输截断大致按 `cooldownMs` 的间隔重试。

默认代码集基于真实会话的证据：这些就是 `knyazev-ai` 实际会话上观察到的瞬态 provider/上游故障。`PI_AI_ERROR` 默认包含在内，尽管在极少数情况下它也携带非瞬态的模块解析环境错误，这是部署方对激进的 provider 故障覆盖的偏好；若你更希望此类失败直接终结而不是重试，可将 `PI_AI_ERROR` 从 `retryableCodes` 中移除。

由于接管是持久重试次数的纯函数，插件在 waterfall 上是顺序无关的：无论它还是 `dsh-llm-retry` 先触发，只有预算法尽的情况才会升级。

## 模型体验

### 模型看到的内容

该插件不添加 prompt、工具 schema 或其他模型可见文本。当它接管某个预算法尽的受限请求时，模型只是看到请求在冷却后最终成功，或在回合被取消时终结失败。不会追加持久性 session 事件。

### Token 影响

为零。一次接管会在冷却后多执行一次模型请求；委托的失败不产生任何由本插件发起的请求。

## 已知限制与延期工作

- 长时间冷却会让回合保持打开状态等待；用户 `cancel` 会中止等待并以终结失败收场。目前没有 Web 表层渲染冷却倒计时；后续客户端改动可从重试链投影出它。
