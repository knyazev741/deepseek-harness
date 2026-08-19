# Agent Note: 首个分片空闲超时与基于压力的自动压缩

Status: implemented

[English](2026-08-18-first-chunk-idle-timeout-pressure-compaction.md) | 中文

## Problem

过大的模型 prompt 的预填充（prefill）时间可能超过流式空闲看门狗的预算。看门狗从请求开始就用同一个 `streamIdleTimeoutMs` 预算（默认五分钟）计时，导致一个约 216k token 的 prompt 在提供方还没产出第一个分片之前、每次都在约 300 秒时被中止。重试策略原样重发同样的负载，因此每次尝试都以相同方式失败；用户只能连续看到多次超时，并不得不手动执行 `/compact`。自动压缩始终没有触发，因为它的 `thresholdRatio`（广告的 400k 窗口的 0.8，约 320k token）远高于该提供方实际卡住的约 216k token；而 GUI 的上下文仪表盘显示 54%——看起来健康——实际上这个回合已经卡死。

## Decision

等待流式首个值的时间不再由分片间空闲预算定价。`dsh-timeout` 的 `idleWatchdog` 现在接受两个预算和两个代码：`firstChunkMs`/`firstChunkCode` 在第一次 `next()` 解析前生效，`idleMs`/`idleCode` 用于之后的每一次请求。两个 LLM 适配器（`dsh-llm-pi-ai` 与 `dsh-llm-deepseek`）都在已有的 `streamIdleTimeoutMs` 之外新增 `firstChunkIdleTimeoutMs` 配置项（默认十五分钟），并把首个分片超时映射为新的 `FIRST_CHUNK_TIMEOUT` 失败代码，而分片间停滞仍为 `TIMEOUT`。`FIRST_CHUNK_TIMEOUT` 属于默认可重试集合。

恢复流程现在能感知上下文大小。`dsh-llm-retry` 在 `agent/request-error` waterfall 中仍是先注册的一方，但对 `FIRST_CHUNK_TIMEOUT` 和 `TIMEOUT`，它会先咨询下游再计算自己的退避：原样采用下游的 `{ kind: 'retry' }` 决定（不追加 `llm/retry` 事件，与溢出路径一致），当下游不恢复时再回退到自己的常规有界重试。`dsh-compaction-basic` 在 `CONTEXT_WINDOW_EXCEEDED` 所用的同一个恢复流程中处理 `FIRST_CHUNK_TIMEOUT` 和 `TIMEOUT`，但用新增的 `idleTimeoutPressureRatio`（默认 0.5）做门槛：当测量到的占用达到或超过路由模型窗口的一半时压缩并返回重试；低于该值、或没有容量可供判断时，则转交下游，让重试策略重发同一负载。`TIMEOUT` 涵盖分片间停滞和 SDK 级请求超时（在总预算内没有任何响应）——两者同样是「prompt 过大无法 prefill 或流式传输」的症状，因此与首个分片超时共用压力门槛，而不是盲目重发同一负载。

Web GUI 让这一状态可见。当失败的尝试携带 `FIRST_CHUNK_TIMEOUT` 或 `TIMEOUT`，且 `contextPressure` 投影达到路由容量的一半以上时，模型重试节点会附加 `/compact` 提示；`ContextMeter` 在占用达到 50% 及以上时用警示色和无障碍标签予以标记。

## Alternatives considered

**全局提高 `streamIdleTimeoutMs`。** 否决：这会延长真正的分片间停滞，却不减少上下文，而且当问题出在 prompt 时也不会触发压缩。

**把 `FIRST_CHUNK_TIMEOUT` 设为不可重试，只依赖压缩。** 否决：低压下的首个分片超时是值得重试的瞬时停滞，让压缩成为唯一处理者会丢掉这次重试。

**重排 bundle，让压缩先于 llm-retry 运行。** 否决：会波及共享 waterfall 上的其它监听器；委托方式保持了 llm-retry 的注册位置，同时只对这个代码让压缩先看一眼。

**按估算的 prompt token 数伸缩首个分片预算。** 否决：固定的宽松默认值加上按提供方覆盖已经覆盖该故障，无需把估算器耦合进适配器并新增配置面。

**只做 GUI 提示、不改后端。** 否决：仅提高可见性仍会让循环盲目重发过大的负载。

## Consequences

提供方合法地预填充大型 prompt 时不再被分片间空闲预算误杀；而过大的 prompt 现在会在重试之前先压缩，而不是原地重试。`FIRST_CHUNK_TIMEOUT` 代码会持久化进会话日志（`llm/retry` 事件携带它），因此回放和 GUI 能区分两种超时原因。新增两个可调参数——`firstChunkIdleTimeoutMs`（按提供方，默认 900 秒）和 `idleTimeoutPressureRatio`（按模型策略，默认 0.5）——它们仍由部署配置而非硬编码。首个分片预算与分片间预算仍是同一个中止信号看门狗，因此调用方中止始终优先于这两者。

## Related

- [调用后压缩压力与溢出恢复](../architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) —— 本变更用基于压力的 `FIRST_CHUNK_TIMEOUT` 触发器扩展的恢复流程。
- [路由模型上下文与压缩策略](../architecture/2026-07-20-routed-model-context-and-compaction-policy.md) —— `idleTimeoutPressureRatio` 加入的 `thresholdRatio`/按模型策略解析机制。
- [从压平的报错文本分类 pi-ai 传输截断](2026-07-22-pi-ai-transport-truncation-classification.md) —— 相邻的 pi-ai 失败分类工作，它先把可恢复的断连措辞映射为可重试代码。
