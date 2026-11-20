---
description: "分支发行版的包职责和配置。"
kind: "package-reference"
---

# @knyazevai/dsh-fork-llm-rate-limit-cooldown

[English](README.md) | 中文

## 概述

当其他恢复机制未处理提供方失败时，本插件在冷却后重试请求。即使路由未设置重试策略，匹配的失败仍适用冷却重试。

## 目录

- [组合方式](#composition)
- [冷却重试](#escalation-after-the-bounded-budget)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="composition"></a>
## 组合方式

```yaml
- id: fork-llm-rate-limit-cooldown
  name: '@knyazevai/dsh-fork-llm-rate-limit-cooldown'
  config:
    cooldownMs: 600000
```

该插件依赖 `agents`，并监听 `agent/request-error` waterfall。它是选择性启用的，普通 profile 不会挂载；Host fork 组合包会与 `dsh-llm-retry` 一起挂载它。

<a id="escalation-after-the-bounded-budget"></a>
## 冷却重试

`dsh-llm-retry` 负责快速退避和提供方的 `always` 策略。其他恢复机制未处理的匹配失败会持续进入冷却重试，直到请求成功或回合取消。`fork-base` 设置 `retryableCodes: ['*']`，涵盖所有规范化的提供方失败。

安排冷却前先运行其他恢复监听器，包括压缩。每次至少等待 `cooldownMs`（默认 `600000`，十分钟），提供方要求更长等待时遵循该值。长等待按 Node 定时器上限分段。取消回合或释放插件会终止等待，阻止下一次请求。

每次等待写入 `mode: always` 的 `llm/retry`，仅在延迟完成后写入 `llm/retry-started`。独立策略链从一开始计数并保持重试标识，因此客户端显示当前等待，而不是已耗尽的快速重试计数。

<a id="model-experience"></a>
## 模型体验

### 重试恢复

#### 模型看到的内容

该插件不添加 prompt、工具 schema 或其他模型可见文本。`llm/retry` 和 `llm/retry-started` 记录不会纳入模型请求。

#### Token 影响

为零。一次接管会在冷却后多执行一次模型请求；委托的失败不产生任何由本插件发起的请求。

#### KV Cache 影响

除非其他已组装的恢复插件修改请求前缀，否则重试保持该前缀不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 长时间冷却会让回合保持打开状态等待；用户 `cancel` 会中止等待并以终结失败收场。目前没有 Web 表层渲染冷却倒计时；后续客户端改动可从重试链投影出它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护背景</summary>

将此包适配到上游 API 时，保留针对分支的测试。配置和行为以上文为准。

</details>
