# Agent Note：有界预算法尽后的长时间冷却限流重试

状态：已实现

[English](2026-08-24-fork-llm-rate-limit-cooldown.md) | 中文

## 问题

`knyazev-ai` provider 在故障期间持续返回 `429`。`dsh-llm-retry` 以快速指数退避重试，直到 provider 的 `retryPolicy.maxRetries`（Host `fork-base` 覆盖层中是 20）；预算法尽后失败是终结性的，直接结束回合。fork 希望在预算法尽后每隔几分钟自动重试一次，让回合无需人工介入即可成功，同时把改动保持为插件，绝不触碰上游 `agent-loop` 或 `llm` 代码。

## 决策

在文档化的 `agent/request-error` waterfall 上增加选择性启用的 fork 插件 `fork-llm-rate-limit-cooldown`。它是顺序无关的：仅当 `failure.code` 位于 `retryableCodes`（默认 `['RATE_LIMIT', 'SERVER', 'QUOTA', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR']`：`RATE_LIMIT` 是 HTTP `429`，`SERVER` 是上游 5xx 如 `502`/`503`，`TRANSPORT` 是流/连接截断，`PI_AI_ERROR` 是 pi-ai catch-all）且该请求在对应 `turn`/`step`/`provider` 上的持久 `llm/retry` 链已达 provider 的 `maxRetries` 时才接管失败；其他情况都通过 `next()` 委托给 `dsh-llm-retry` 或后续监听器。接管后等待 `cooldownMs`（默认 `600000` = 10 分钟），该等待可被回合 signal 和插件销毁取消，然后返回 `{ kind: 'retry' }`，让 loop 重新运行同一请求。

由于接管是持久重试次数的纯函数，waterfall 上的监听器顺序无关紧要；Host `fork-base` patch 在 `dsh-llm-retry` 之后插入该行并设 `cooldownMs: 600000`，因此持续性 `429`、上游 `5xx`、配额、超时或传输截断大约每十分钟重试一次，直到成功或用户取消。

默认代码集基于证据：扫描 `~/.dsh/sessions` 中近期活跃的 `knyazev-ai` 会话，浮现出这些瞬态 provider/上游故障（`RATE_LIMIT`、`SERVER`/502、`QUOTA`、`TIMEOUT`、`TRANSPORT`，以及 `PI_AI_ERROR` catch-all）。`PI_AI_ERROR` 默认包含在内，尽管在极少数情况下它也携带非瞬态的 `Cannot find module` 环境错误，这是部署方对 provider 故障覆盖的偏好；可从 `retryableCodes` 中移除它以让此类失败直接终结。

## 考虑过的替代方案

**修改上游 `agent-loop` 或 `llm-retry`。** 被拒绝：fork 通过插件保持行为改动，且 loop 已暴露所需的重试动作路径。

**将 provider 配置为 `retryPolicy.mode: always`。** 被拒绝：无界重试会立即以快速退避重启，这会在限流 provider 上反复冲击，而不是等待较长的冷却时间。

## 结论

持续性 `429`、上游 `5xx`、配额、超时、传输截断或 pi-ai catch-all 会让回合保持存活并按 `cooldownMs` 大致间隔重试，直到成功或取消。该插件不添加 prompt、工具 schema 或持久 session 事件；成功请求的 token 影响为零。包测试证明升级、委托、取消和销毁路径，每文件覆盖率为 100%；Host `fork-base` 组合包的接线由其自身 spec 断言。
