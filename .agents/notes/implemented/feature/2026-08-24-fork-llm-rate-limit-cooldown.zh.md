# Agent Note：有界预算法尽后的长时间冷却限流重试

状态：已实现

[English](2026-08-24-fork-llm-rate-limit-cooldown.md) | 中文

## 问题

`knyazev-ai` provider 在故障期间持续返回 `429`。`dsh-llm-retry` 以快速指数退避重试，直到 provider 的 `retryPolicy.maxRetries`（Host `fork-base` 覆盖层中是 20）；预算法尽后失败是终结性的，直接结束回合。fork 希望在预算法尽后每隔几分钟自动重试一次，让回合无需人工介入即可成功，同时把改动保持为插件，绝不触碰上游 `agent-loop` 或 `llm` 代码。

## 决策

在文档化的 `agent/request-error` waterfall 上增加选择性启用的 fork 插件 `fork-llm-rate-limit-cooldown`。它是顺序无关的：仅当 `failure.code` 位于 `retryableCodes`（默认 `['RATE_LIMIT', 'SERVER']`：`RATE_LIMIT` 是 HTTP `429`，`SERVER` 是上游 5xx 如 `502`/`503`）且该请求在对应 `turn`/`step`/`provider` 上的持久 `llm/retry` 链已达 provider 的 `maxRetries` 时才接管失败；其他情况都通过 `next()` 委托给 `dsh-llm-retry` 或后续监听器。接管后等待 `cooldownMs`（默认 `600000` = 10 分钟），该等待可被回合 signal 和插件销毁取消，然后返回 `{ kind: 'retry' }`，让 loop 重新运行同一请求。

由于接管是持久重试次数的纯函数，waterfall 上的监听器顺序无关紧要；Host `fork-base` patch 在 `dsh-llm-retry` 之后插入该行并设 `cooldownMs: 600000`，因此持续性 `429` 或上游 `5xx` 大约每十分钟重试一次，直到成功或用户取消。

## 考虑过的替代方案

**修改上游 `agent-loop` 或 `llm-retry`。** 被拒绝：fork 通过插件保持行为改动，且 loop 已暴露所需的重试动作路径。

**将 provider 配置为 `retryPolicy.mode: always`。** 被拒绝：无界重试会立即以快速退避重启，这会在限流 provider 上反复冲击，而不是等待较长的冷却时间。

## 结论

持续性 `429` 或上游 `5xx` 会让回合保持存活并按 `cooldownMs` 大致间隔重试，直到成功或取消。该插件不添加 prompt、工具 schema 或持久 session 事件；成功请求的 token 影响为零。包测试证明升级、委托、取消和销毁路径，每文件覆盖率为 100%；Host `fork-base` 组合包的接线由其自身 spec 断言。
