# Agent Note: 首个分片空闲超时时压缩上下文，然后重试

Status: implemented

[English](2026-08-27-fork-llm-first-chunk-compaction.md) | 中文

## 问题

在长时间运行的会话中，提供方偶尔会卡在第一个 LLM 分片上：在首个结果窗口内没有任何数据到达，因此 `fork-llm-first-chunk-timeout` 会以 `TIMEOUT` 失败终止流，该轮也随之结束。经验表明，这种卡顿与非常大的上下文相关，强制压缩一次就能让同一请求在重试时成功。自动压缩只在它自己的触发条件出现时才触发（步骤边界的 `pressure`，以及提供方确认溢出时的 `context-overflow`），因此它永远不会响应首个分片卡顿。fork 想要的是：发生首个分片空闲超时时，压缩一次，并从压缩后的 surface 继续该轮，而不是白白浪费无法起作用的中间快速重试。

## 决策

扩展选择性启用的 `fork-llm-first-chunk-timeout` 插件，使其首次读取超时发出一个独立的 `FIRST_CHUNK_TIMEOUT` 失败码，并新增一个伴随的 `agent/request-error` 监听器（以 `prepend` 注册，因此会先于 `dsh-llm-retry` 执行）。发生 `FIRST_CHUNK_TIMEOUT` 失败时，先通过 `compaction` 服务强制压缩一次（`compactIfNeeded(agent, 'context-overflow', signal)`），然后返回 `{ kind: 'retry' }`，让 agent 循环从新的替换 surface 重新发起同一请求。会跳过快速退避，因为它无法修复卡住的首个分片；强制的 `context-overflow` 路径即使在低于常规压力阈值时也会缩减上下文。

恢复由一个新增的 `maxFirstChunkCompactionRetries` 配置（默认 `3`）按失败的 `turn`/`step`/`provider` 加以限制。当同一步骤在超过上限后仍持续超时，或压缩没有产生持久进展（没有可压缩的范围，或在未推进 surface 代次的情况下出错）时，监听器会否决整条 waterfall（不调用 `next()` 直接返回），让原始 `FIRST_CHUNK_TIMEOUT` 错误迅速结束该轮，而不是陷入无休止的重试。如果没有 `compaction` 引擎，监听器会通过 `next()` 委托，保留插件原有的独立行为。agent 转为空闲时会丢弃每个 agent 的记账状态。

## 备选方案

**先让 `dsh-llm-retry` 对 `FIRST_CHUNK_TIMEOUT` 进行快速重试。** 否决：快速重试无法缩小导致卡顿的过大上下文，因此 fork 会在第一次超时时立即压缩，而不是先耗尽重试预算。

**仅复用 compaction-basic 的 `context-overflow` 处理器。** 它受提供方溢出码和 `maxOverflowRetries` 限制；首个分片卡顿并不是溢出信号，因此 fork 需要自己的触发条件。

## 后果

首个分片空闲超时现在会触发一次强制压缩和同一步骤的重试；一旦压缩后的请求开始正常流转，该轮就会正常完成；如果压缩再也无法帮助，则会以 `FIRST_CHUNK_TIMEOUT` 错误结束该轮。插件不会新增提示词或工具 schema；压缩完全是 compaction 服务的持久化 surface 工作。包测试证明了重试、无进展时否决、达到上限时否决、对其他码的委托、缺少 compaction 引擎、中止信号、抛出但带有/不带有持久进展等场景，并达到 100% 的逐文件覆盖率；`fork-base` 包的接线由其自身的 spec 断言。
