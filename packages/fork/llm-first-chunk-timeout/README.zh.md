# @deepseek-ai/dsh-fork-llm-first-chunk-timeout

[English](README.md) | 中文

该函数插件限制 `llm/stream` waterfall 等待第一个结果时的空闲时间。它是选择性启用的，普通 profile 不会挂载它。

## 组合

```yaml
- id: fork-llm-first-chunk-timeout
  name: '@deepseek-ai/dsh-fork-llm-first-chunk-timeout'
  config:
    firstChunkIdleTimeoutMs: 120000
```

插件要求 `llm`，并且每次 waterfall 调用恰好调用一次无参数 continuation。插件只读取冻结请求，不会修改它；请求自带的调用方 `signal` 仍是提供方的取消输入。

## 首个结果截止时间

`firstChunkIdleTimeoutMs` 默认值为 `120000`，必须是正的安全整数，且不得超过 Node 可靠定时器的上限 `2147483647`。计时器只与下游第一次 `iterator.next()` 结果竞争。产生值或正常返回 `done` 都会清除计时器并原样转发迭代器，因此不会施加分片之间的截止时间。

计时器先到时，包装器会产生一个带可重试 `TIMEOUT` 失败码的终端 `finish` 分片，并开始调用下游 `return()`，但不会等待它。调用方中止时，插件只清除自己的计时器，并保留下游提供方的取消结果。下游拒绝会保持同一个拒绝。消费方提前返回或插件卸载时会清除插件状态，并尽力关闭下游。

## 模型体验

### 流失败

#### 模型看到的内容

插件不会新增提示词或工具 schema。首个结果截止时间先到时，流会以以下稳定诊断和 `TIMEOUT` 失败码终止：

##### 超时诊断

```markdown
first LLM chunk idle timeout after <firstChunkIdleTimeoutMs>ms
```

#### Token 影响

流在截止时间前产生结果时为零；超时时，用一个终端失败分片替代缺失的提供方结果。

#### KV Cache 影响

独立；插件不会重写请求或任何模型可见前缀。

## 已知限制与延后工作

- **提供方取消**——冻结请求和无参数 continuation 无法向已经阻塞在自身读取操作中的提供方注入派生信号。超时是面向 agent 的首个结果截止时间；传输取消仍由提供方现有的 `signal` 约定负责。
- **Profile 组合**——该包是选择性启用的，只有部署显式组合时才会挂载。

所有权理由记录在 [fork Host 覆盖层 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-22-fork-host-overlay.zh.md) 中。
