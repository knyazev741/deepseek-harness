---
description: "分支发行版的包职责和配置。"
kind: "package-reference"
---

# @knyazevai/dsh-fork-external-session

[English](README.md) | 中文

## 概述

面向选择性启用的外部会话实现的 provider-neutral Host 注册表。该程序包提供 `ctx.externalSessions`、可通过合并扩展的 [`ExternalSessionModeMap`](src/index.ts)，以及由 effect 所有的注册与查找操作。它不定义 provider 协议、进程运行器、权限桥、转录事件、渲染器或默认 provider。

## 目录

- [组装](#composition)
- [明确范围](#deliberate-scope)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="composition"></a>
## 组装

没有任何 provider 时，注册表仍然是有效的。后续 provider 程序包通过合并 `ExternalSessionModeMap` 声明自己的 mode 与 provider 类型，然后挂载自己的插件并注册实现：

```ts
import { Context } from '@deepseek-ai/cordis'
import ExternalSessions from '@knyazevai/dsh-fork-external-session'

interface ExampleProvider { run(): void }
const ctx = new Context()
await ctx.plugin(ExternalSessions)
const provider: ExampleProvider = { run() {} }

declare module '@knyazevai/dsh-fork-external-session' {
  interface ExternalSessionModeMap {
    example: ExampleProvider
  }
}

ctx.externalSessions.register('example', provider)
const resolved = ctx.externalSessions.lookup('example')
```

`register(mode, provider)` 在替换已有 provider 之前拒绝重复 mode，并返回由注册方 Cordis fiber 所有的 disposer。dispose 只移除该次注册；过期 disposer 不能移除后续替换。没有 provider 注册到请求 mode 时，`lookup(mode)` 会抛错，因此调用方不会静默回退到其他实现。

<a id="deliberate-scope"></a>
## 明确范围

此程序包只负责 mode 到 provider 的映射表。provider 自己负责进程、线路、实时会话、权限、转录与模型约定。后续 Codex 集成必须作为显式 provider 与 Web bundle 挂载；该注册表不依赖默认 Codex。

<a id="model-experience"></a>
## 模型体验

### Host 注册表

#### 模型看到的内容

该注册表仅位于 Host，不贡献提示词、工具 schema、消息、流、持久事件或模型请求。它的 `register()` 和 `lookup()` 操作只影响 Host 侧 provider 选择。

#### Token 影响

为零。注册和查找只改变 Host 侧 provider 选择，不增加任何模型 token。

#### KV Cache 影响

为零。该注册表不会组装 provider 请求，也不会改变模型可见前缀，因此既不增加也不使模型 KV cache 输入失效。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **Provider 生命周期由 provider 负责**——注册 dispose 会移除查找条目，但不会推断 provider 如何释放自己的资源。
- **Mode 声明是编译期扩展**——provider 程序包必须先合并 `ExternalSessionModeMap` 再注册 mode；当前组装中未注册的运行时名称会在查找时失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护背景</summary>

将此包适配到上游 API 时，保留针对分支的测试。配置和行为以上文为准。

</details>
