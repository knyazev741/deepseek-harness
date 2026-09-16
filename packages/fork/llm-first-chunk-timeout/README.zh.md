---
description: "分支发行版的包职责和配置。"
kind: "package-reference"
---

# @knyazevai/dsh-fork-llm-first-chunk-timeout

[English](README.md) | 中文

## 概述

该函数插件限制 `llm/stream` waterfall 等待第一个结果时的空闲时间。它是选择性启用的，普通 profile 不会挂载它。

## 目录

- [组合](#composition)
- [首个结果截止时间](#first-result-deadline)
- [首个分片压缩恢复](#first-chunk-compaction-recovery)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="composition"></a>
## 组合

```yaml
- id: fork-llm-first-chunk-timeout
  name: '@knyazevai/dsh-fork-llm-first-chunk-timeout'
  config:
    firstChunkIdleTimeoutMs: 120000
    maxFirstChunkCompactionRetries: 100
```

插件要求 `llm`，并且每次 waterfall 调用恰好调用一次无参数 continuation。插件只读取冻结请求，不会修改它；请求自带的调用方 `signal` 仍是提供方的取消输入。

<a id="first-result-deadline"></a>
## 首个结果截止时间

`firstChunkIdleTimeoutMs` 默认值为 `120000`，必须是正的安全整数，且不得超过 Node 可靠定时器的上限 `2147483647`。计时器只与下游第一次 `iterator.next()` 结果竞争。产生值或正常返回 `done` 都会清除计时器并原样转发迭代器，因此不会施加分片之间的截止时间。

计时器先到时，包装器会产生一个带 `FIRST_CHUNK_TIMEOUT` 失败码的终端 `finish` 分片，并开始调用下游 `return()`，但不会等待它。调用方中止时，插件只清除自己的计时器，并保留下游提供方的取消结果。下游拒绝会保持同一个拒绝。消费方提前返回或插件卸载时会清除插件状态，并尽力关闭下游。消费方调用 `throw(error)` 时，如果下游提供 `throw` 就委托并保留其结果或拒绝；否则会尽力关闭下游，并以调用方错误拒绝。

<a id="first-chunk-compaction-recovery"></a>
## 首个分片压缩恢复

发生 `FIRST_CHUNK_TIMEOUT` 失败时，插件会在 `agent/request-error` 前插入一个监听器：如果 `agentPresets.serviceFor(agent, 'compaction')` 提供了 agent 的隔离 `compaction` 服务，就通过该服务强制压缩一次上下文；否则使用宿主的 `compaction` 服务（触发器为 `context-overflow`）。当摘要器执行提供方策略的重试与 cooldown 等待时，压缩操作会保持活动。压缩产生持久进展后，会暂存一条内容严格为 `continue`、来源属于插件的消息，同时监听器不返回重试动作。超时请求以原始错误结束；其 driver 到达 `idle` 时，`agent.followup()` 才插入暂存消息并唤醒从替换 surface 开始的新一轮。必须延迟到 `idle` 再插入，因为在失败 driver 内插入的 follow-up 会在该 driver 退出后留在队列中。压缩成功时会跳过 `dsh-llm-retry` 的快速退避，因为它无法修复卡住的首个分片。如果压缩失败或没有产生持久进展，监听器会委托给下游 retry/cooldown 策略；如果没有下游策略接管失败，原始超时会结束该轮。`maxFirstChunkCompactionRetries`（默认 `100`）限制本次恢复活动完成前连续触发的压缩 follow-up 次数；达到上限时仍会结束超时轮且不再追加 continuation。在既没有隔离的也没有宿主的 `compaction` 引擎时，监听器会通过 `next()` 委托，保留插件的独立行为。

<a id="model-experience"></a>
## 模型体验

### 流失败

#### 模型看到的内容

插件不会新增 prompt section 或工具 schema。首个结果截止时间先到时，流会以以下稳定诊断和 `FIRST_CHUNK_TIMEOUT` 失败码终止。恢复成功后，下一轮会收到以下带插件来源的持久 user-role 继续消息。

##### 超时诊断

```markdown
first LLM chunk idle timeout after <firstChunkIdleTimeoutMs>ms
```

##### 继续消息

```markdown
continue
```

#### Token 影响

流在截止时间前产生结果时为零。超时恢复成功时会在压缩后增加短消息 `continue` 和一次新的模型请求。

#### KV Cache 影响

恢复成功时会使用压缩后的替换 surface 并追加 `continue`，因此新请求具有不同的模型可见前缀，不会逐字复用超时请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **提供方取消**——冻结请求和无参数 continuation 无法向已经阻塞在自身读取操作中的提供方注入派生信号。超时是面向 agent 的首个结果截止时间；传输取消仍由提供方现有的 `signal` 约定负责。
- **Profile 组合**——该包是选择性启用的，只有部署显式组合时才会挂载。

所有权理由记录在 [fork Host 覆盖层 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-22-fork-host-overlay.zh.md) 中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护背景</summary>

将此包适配到上游 API 时，保留针对分支的测试。配置和行为以上文为准。

</details>
