# Agent Note: 压缩摘要器重试与 agent 作用域恢复

Status: implemented

[English](2026-08-29-compaction-summarizer-retry.md) | 中文

## 问题

基础压缩后端会直接调用 LLM seam 来执行辅助摘要调用，而 `dsh-llm-retry` 处理的是循环的 `agent/request-error` 扩展点。因此摘要失败不会进入通常的 agent 重试路径。在 Web 组合中，压缩服务挂载在隔离的 agent-preset realm 中，而首分片恢复运行在宿主 realm，无法通过 `ctx.get('compaction')` 找到该服务。这样一来，临时的上游过载可能会在恢复 follow-up 暂存之前结束压缩。

## 决策

`compaction-basic` 解析所选提供方路由捕获的 `ResolvedRetryPolicy`，并将其应用于每次辅助流尝试。普通路由在 `maxRetries` 范围内使用快速退避；有限预算耗尽后，`summarizerCooldownMs`（默认 `600000`）等待并重试符合条件的临时失败，且不重置快速计数。always 路由使用没有上限的本地退避。路由限制以内的有效提供方 `Retry-After` 会被遵守；超过上限的值会使普通路由失败，并让 always 路由回退到本地延迟。取消与不可重试失败仍具有最终决定权，每次尝试都会创建新的 block assembler。

首分片恢复 listener 会先解析 `ctx.agentPresets.serviceFor(agent, 'compaction')`，然后才回退到宿主压缩服务。它只有在压缩取得持久替换进展后才暂存插件创建的 `continue` follow-up，因此 `FIRST_CHUNK_TIMEOUT` 会在摘要器重试或等待 cooldown 时保持在恢复操作中。

## 考虑过的替代方案

- **复用 `dsh-llm-retry` 处理摘要**——否决，因为该 listener 挂在 agent request-error waterfall 上，而直接压缩可能没有开放的轮次或步骤。
- **把临时摘要失败视为最终失败并等待用户继续**——否决，因为首分片恢复在临时上游故障期间无法取得进展。
- **将隔离压缩服务移到宿主 realm**——否决，因为 agent preset 拥有该服务实例，不同 agent 可能拥有不同的组合和策略。
- **每次 cooldown 后重置快速重试预算**——否决，因为持续不可用的提供方会收到无上限的快速突发；cooldown 重试继续进行，但不会放大快速突发预算。

## 后果

临时摘要失败可以让活动的压缩操作通过提供方策略重试和配置的 cooldown 等待继续存活，使首分片恢复只在持久替换存在后恢复。cooldown 只限制预算耗尽后各次尝试之间的等待时间，不限制尝试次数。直接摘要器重试记录为操作日志，而不是 `llm/retry` 事件，因为它们可能在轮次／步骤之外运行。可选的 agent-presets peer dependency 让恢复插件继续支持仅宿主的组合方式。

## 测试

聚焦测试覆盖路由策略快速重试、cooldown 重试、提供方延迟处理、取消、带 code 的 middleware 失败、配置校验以及隔离 agent-preset 压缩服务查找。assembled headless 压缩快照注入两次临时摘要器失败，并验证持久压缩和 continuation 仍能完成。变更后的摘要器／配置与恢复模块聚焦覆盖率为 100%。
