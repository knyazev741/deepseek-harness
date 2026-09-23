# Agent Note: 首个分片空闲超时时压缩上下文，然后发送 follow-up

Status: implemented

[English](2026-08-27-fork-llm-first-chunk-compaction.md) | 中文

## 问题

在长时间运行的会话中，提供方偶尔会卡在第一个 LLM 分片上：在首个结果窗口内没有任何数据到达，因此 `fork-llm-first-chunk-timeout` 会以 `TIMEOUT` 失败终止流，该轮也随之结束。经验表明，这种卡顿与非常大的上下文相关；手动压缩后提交 `continue` 可以恢复有效工作。自动压缩只在它自己的触发条件出现时才触发（步骤边界的 `pressure`，以及提供方确认溢出时的 `context-overflow`），因此它永远不会响应首个分片卡顿。重复失败的提供方请求并不安全，因为该步骤可能描述的是长会话中很久以前的工作；恢复必须从压缩后的当前 surface 开启新一轮。

## 决策

扩展选择性启用的 `fork-llm-first-chunk-timeout` 插件，使其首次读取超时发出一个独立的 `FIRST_CHUNK_TIMEOUT` 失败码，并新增一个伴随的 `agent/request-error` 监听器（以 `prepend` 注册，因此会先于 `dsh-llm-retry` 执行）。发生 `FIRST_CHUNK_TIMEOUT` 失败时，先通过 `compaction` 服务强制压缩一次（`compactIfNeeded(agent, 'context-overflow', signal)`）。产生持久进展后，暂存一条内容严格为 `continue`、由插件生成的消息，且监听器不返回重试动作。失败请求因此先以原始超时结束；其 `idle` 状态转换随后通过 `agent.followup()` 插入暂存消息，并从替换 surface 唤醒新一轮。如果在失败 driver 内插入 follow-up，它会在该 driver 退出后留在队列中。会跳过快速退避，因为它无法修复卡住的首个分片；强制的 `context-overflow` 路径即使在低于常规压力阈值时也会缩减上下文。

恢复由 `maxFirstChunkCompactionRetries`（默认 `100`）在一次连续的 agent 活动内加以限制。每个成功的压缩 follow-up 都会开启新的编号轮次，因此按失败的 `turn`/`step` 计数会重置上限并允许无界链。达到上限时会委托给下游 retry/cooldown。[禁止连续压缩的决策](../bug-fix/2026-09-23-no-consecutive-auto-compaction.zh.md) 还要求先有新的 assistant 响应，基本后端才允许再次压缩。压缩出错或没有产生持久进展时，会委托给下游 retry/cooldown 策略；如果没有下游策略接管失败，原始超时会结束该轮。如果没有 `compaction` 引擎，监听器会通过 `next()` 委托，保留插件原有的独立行为。agent 转为空闲时会丢弃每个 agent 的记账状态。

## 备选方案

**先让 `dsh-llm-retry` 对 `FIRST_CHUNK_TIMEOUT` 进行快速重试。** 否决：快速重试无法缩小导致卡顿的过大上下文，因此 fork 会在第一次超时时立即压缩，而不是先耗尽重试预算。

**仅复用 compaction-basic 的 `context-overflow` 处理器。** 它受提供方溢出码和 `maxOverflowRetries` 限制；首个分片卡顿并不是溢出信号，因此 fork 需要自己的触发条件。

**压缩后重试同一个提供方请求。** 否决：该请求属于失败步骤，可能代表 agent 在许多轮以前已经完成的工作。持久 `continue` follow-up 会针对当前压缩历史复现已经验证的手动恢复流程。

## 后果

首个分片空闲超时现在会触发一次强制压缩、关闭失败轮次，并为新一轮排入一条由插件生成的持久 `continue` 消息。插件不会新增 prompt section 或工具 schema，但恢复成功时会有意改变模型可见历史并发起新请求。包测试证明了准确的 follow-up 内容与来源、真实 agent driver 从 error 到 idle 的唤醒路径、不重试同一个请求、跨轮次上限、压缩无进展时回退到下游策略、对其他码的委托、缺少 compaction 引擎、中止信号，以及抛出但带有／不带有持久进展等场景；`fork-base` 包的接线由其自身 spec 断言。
