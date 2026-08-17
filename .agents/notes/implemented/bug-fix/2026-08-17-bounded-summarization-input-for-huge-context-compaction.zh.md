# Agent Note: 面向超长上下文压缩的有界摘要输入

Status: implemented

[English](2026-08-17-bounded-summarization-input-for-huge-context-compaction.md) | 中文

## Problem

压缩会将已遮蔽区域回放到摘要调用中，以保持提供方热前缀 cache 对齐（[前缀 cache 复用决策](2026-07-21-compaction-summary-prefix-cache-reuse.md)）。在超长上下文模型上，该区域非常庞大：在 400k 窗口的默认 `0.8` 压力阈值下，回放可达约 300k token 的单次请求。慢网关对如此大的 prefill 可能超过 pi-ai 适配器流空闲看门狗的时限（默认 300s），于是摘要流以 `pi-ai stream idle timeout after 300000ms` 失败，压缩随之报「could not produce a useful summary」。在路由到 `knyazev-ai/deepseek-v4-flash` 的 350k token 会话上复现：`/compact` 写入 `compaction/start` 后，摘要调用立即以与对话自身超大请求相同的方式超时。提高输出上限无济于事——失败来自输入端 prefill，而非 `max-tokens` 截断。

## Decision

`dsh-compaction-basic` 新增策略字段 `maxSummarizationInputTokens`（默认 `131072`；`0` 回放整个区域，保留旧行为）。范围选择将头部锚定 span 约束为**定价 token 超过预算的最短前缀**，再将末端切分点前移直至工具配对平衡。选择跨过预算的前缀——绝不在它之前停止——保证 span 不会小到单独触发「摘要必须小于被遮蔽内容」检查失败。

有界选择应用于所有选范围之处：

- 自动步骤压力与溢出遍次每次尝试只选一个有界块，因此超长区域通过多个小而快的摘要调用收敛，而非一次超大 prefill。
- `compactNow()` 在单次 `runMaintenance` 预留下循环有界遍次，直到无范围可选或所选 span 全部由先前压缩检查点构成（否则终态遍次会重新压缩孤立检查点并触发缩小检查失败）。每次遍次仍是独立的事务括号并各自持久化 flush，且在每次遍次前断言活动压缩锁。

预算按设计是软约束：工具配对边界可能让一对节点超出预算，超大单节点始终单独参与遍次。

## Consequences

- 每次摘要 prefill 都有界（默认约 128k token），因此压缩在无法及时 prefill 整个区域的超长上下文会话上可用。
- 超大会话上的 `/compact` 现在一次调用即可完成整个表层（多次有界遍次），而不是失败或需要反复执行。
- [前缀 cache 复用决策](2026-07-21-compaction-summary-prefix-cache-reuse.md)的逐字前缀声明在所回放的 span 上仍然成立；变化的只是 span 长度。
- 每次遍次的检查点按现有压缩指令合并先前检查点，因此分块遍次不会累积冗余摘要。

## Alternatives considered

- **调高提供方流空闲超时**（`streamIdleTimeoutMs`）——配置层面的权宜之计，每次压缩仍要支付数分钟 prefill；仅作为运维侧的补充旋钮保留，不是修复。
- **限制摘要输出**（`maxTokens`）——针对的是错误的失败模式；观察到的错误是输入端 prefill 超时，而非输出截断。
- **只摘要区域最近窗口**——会丢失对话头部，而整个区域的检查点必须保留它。
