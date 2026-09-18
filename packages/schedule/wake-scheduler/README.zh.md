---
description: "由 agent 设置的持久唤醒计划：wake_schedule_set、wake_schedule_status 与 wake_schedule_cancel 在调用方会话中启动周期性回合，并提供可选的 profile 配置回退。"
kind: "package-reference"
---

# @knyazevai/dsh-wake-scheduler

[English](README.md) | 中文

## 概述

Wake Scheduler 让 agent（智能体）给自己的会话设定定时器：它在同一会话中调用 `wake_schedule_set`，harness 便按间隔用 agent 的提示词启动一个普通回合，即使无人写入；`wake_schedule_status` 与 `wake_schedule_cancel` 用于查看或停止它。它存在的原因是：后台 job 的完成通知不会唤醒空闲会话——它们会排队，并在下一条人类消息到达时一起出现，于是一旦会话安静下来，承诺的周期性检查就会失效。profile 可以预置一份回退计划，但 agent 设置的计划优先，并且能跨重启保留。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当某个会话必须在无人照看的情况下持续工作——周期性检查、长时间观察、定时复核——并且该会话在运行中的 `dsh` 进程里保持活跃时，请选择 Wake Scheduler。当工作必须到达会话之外、或者当你需要日历或 Cron 规则时，请不要使用它：这里的间隔是固定的整分钟。

### 安装 overlay

在 profile 挂载它之前，调度器始终处于惰性状态；加载后创建的每个根会话都会获得面向 agent 的工具：

```sh
dsh web --patch apps/cli/config/examples/wake-scheduler/cordis.yml
```

```yaml
- insert:
    - id: wake-scheduler
      name: '@knyazevai/dsh-wake-scheduler'
      config:
        enabled: false
```

在随附的默认值 `enabled: false` 下，agent 仍可自行设置计划，只是 profile 不会预置任何计划。

### 让 agent 自行设置计划

让 agent 自己唤醒，它会在当前会话中调用 `wake_schedule_set`；永远不需要传会话 id，因为该工具作用于持有它的 agent scope 所属的会话。调用成功后会返回已存储的计划，包括下次到期时刻：

```json
{"scheduled":true,"status":"active","source":"tool","prompt":"check the build","intervalMinutes":30,"nextRunAt":"2026-09-18T00:30:00.000Z","lastRunAt":null,"runs":0,"overdue":false,"skippedIntervals":0}
```

三个工具就是全部接口：`wake_schedule_set` 接受 `interval_minutes`（必填，整分钟）、可选的 `prompt`，以及可选的 `start_delay_minutes`（默认等于间隔；`0` 表示立即触发首次唤醒）。`wake_schedule_status` 不接受参数，报告计划本身、下次与上次唤醒时刻、已触发次数、当前是否排队了一次补发唤醒，以及最近一次补发合并了多少个间隔。`wake_schedule_cancel` 不接受参数，停止该会话的计划，并在之后再次 set 之前抑制任何 profile 回退。再次设置会替换此前的计划。

### 启用 profile 回退

profile 可以为尚无计划的会话预置同类计划，让新会话一开就是周期性的：

```yaml
- insert:
    - id: wake-scheduler
      name: '@knyazevai/dsh-wake-scheduler'
      config:
        enabled: true
        intervalMinutes: 30
        prompt: 'Scheduled check-in: continue the plan and report anything that needs my decision.'
        sessionId: session-...
```

启用回退却缺少间隔或提示词为空时，会在插件加载时明确失败。agent 设置或取消的记录始终优先于回退，回退也绝不会改写它。

### 重启与冷会话时的行为

每份计划都按会话 id 持久存储，因此可以跨 harness 重启和已关闭的会话保留。如果目标时刻在会话未打开时已经过去，下次加载只会补发一个回合——绝不重放积压——并记录它合并了多少个间隔；在补发回合运行之前，`wake_schedule_status` 会以 `overdue: true` 和 `skippedIntervals` 报告这一点。计划从补发那一刻起保持自己的节奏。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 作用域与组合

插件声明 `inject = ['agents', 'storageDomain', 'tools']`，是带有 `name` / `inject` / `Config` / `apply` 的函数插件。它只观察加载之后发布的 `agent/created` 事件，并在每个匹配根 agent 的专属 scope 中注册这三个工具，因此工具调用是通过 scope 而不是参数来确定自己的会话。subagent 永远不会被调度，加载时已经存活的 agent 也不会被接管。

### 回合从何而来

到期的唤醒会调用 `agent.followup(createUserMessage({ content, source: { kind: 'plugin', plugin: 'wake-scheduler' } }))`，也就是循环的普通 follow-up 边界：它排队一个正常的用户回合并唤醒 driver，绝不会 steer 或打断正在运行的工作。这里不会创建后台 job，不会追加私有的会话事件类型，也不会触碰 job 通知路径。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、`agent/created` 观察、回退预置、按 agent 安装工具 |
| [`src/tools.ts`](src/tools.ts) | 三个面向 agent 的工具、其 schema、校验与持久变更 |
| [`src/runtime.ts`](src/runtime.ts) | live 定时器所有者：按已存计划设置定时器、单回合派发、隔离、处置 |
| [`src/scheduling.ts`](src/scheduling.ts) | 纯运算与规范的模型可见状态视图 |
| [`src/persistence.ts`](src/persistence.ts) | 持久 `wake_scheduler` 域及其严格记录 schema |

### 持久状态

`wake_scheduler` 域（版本 1，表 `schedules`）为每个会话 id 保存一条记录，包含状态、来源、提示词、间隔、起始延迟、上次与下次唤醒时刻、运行次数、跳过次数与写入时间。这是宿主侧运行状态而非会话历史：不新增任何会话事件类型，`SESSION_FORMAT_VERSION` 也不变，因此没有该插件的构建仍能读取日志。set 或 cancel 只有在后端持久化之后才会返回。

### 失败隔离

抛出异常的 follow-up 会被隔离：本次运行不推进任何状态、记录一条 `warn`，并在一个完整间隔后重试，因此损坏的目标不会空转。计划写入失败也以同样方式隔离；已投递的回合仍然有效，下一个间隔照常继续。如果目标不再是该会话的活跃根 agent，就会被跳过，其记录保持逾期状态留给下次加载。处置会清除每个已设置的定时器，但不删除持久计划。

### 为什么没有 `./invariant` 伴随包

No invariant companion is published because 本包不读取任何可能与它所拥有的观测发生背离的第二种观测。每次变更都是对域表的一次持久写入，随后依据该已存记录重新设置一次定时器，因此没有可断言的独立观测；伴随包及其接线被省略，而不是空着发布。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [schedule 组](../README.zh.md) — 同级的会话本地提醒包，其记录也会作为会话回合交付。
- [会话本地 Schedule 子系统](../../../docs/subsystems/schedule.zh.md) — 本包刻意未复用的提醒记录与交付契约。
- [持久 Web Schedule 决策](../../../.agents/notes/implemented/feature/2026-08-05-durable-web-schedule.zh.md) — live owner 提醒交付的既有实践。
- [由 profile 配置的唤醒调度器决策](../../../.agents/notes/implemented/feature/2026-09-18-profile-wake-scheduler.zh.md) — 说明本包为何独立于 Schedule，以及它刻意不唤醒什么。

-----

<a id="model-experience"></a>
## 模型体验

### 唤醒计划工具

#### 模型看到什么

在本插件加载后创建的每个活跃根 agent 中，模型会看到三个 schema。`wake_schedule_set` 接受 `interval_minutes`（必填整分钟，至少 1）、`prompt`（可选；省略时使用通用检查提示），以及 `start_delay_minutes`（可选整分钟，`0` 表示立即触发）。`wake_schedule_status` 与 `wake_schedule_cancel` 不接受参数。每个结果都是规范 JSON 状态对象，或带 `invalid_interval`、`invalid_prompt`、`persistence_uncertain`、`internal_error` 之一的封闭错误。

#### Token 影响

只要插件已安装，这三个 scoped schema 就会增加一个固定的请求前缀。每次执行的工具都会通过普通工具结果管道添加其数据相关的 JSON 结果；本包不添加私有的截断或 token 预算。

#### KV 缓存影响

在定义与作用域不变时，这些 schema 保持前缀稳定。工具调用与结果会追加到后续历史中，并保持已经可复用的前缀。

### 计划唤醒回合

#### 模型看到什么

每个到期的间隔会排队一条普通的 user 角色消息，其文本就是计划中的提示词原文，并带有 `source: { kind: 'plugin', plugin: 'wake-scheduler' }` 标记。本包不添加 system prompt 段落，也不添加任何其他模型可见输入。

#### Token 影响

每次唤醒都会添加一条依赖数据的用户消息，它会保留在会话历史中并贡献其 token，直到普通压缩将其移除。插件不会向请求前缀添加任何内容。

#### KV 缓存影响

唤醒会追加在既有历史之后，并保持已经可复用的前缀；只有被追加的消息取决于所存储的提示词。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限活跃进程** — 只有当被调度的会话是运行中 `dsh` 进程的活跃根 agent 时，唤醒才会触发；冷会话只有在再次被加载时才会得到那唯一一次补发回合。不存在外部通道。
- **固定间隔，而非日历规则** — `interval_minutes` 是以设置时刻为锚点的整分钟数；不支持 Cron 与星期规则。
- **工具目录尚未采集** — `pnpm run gen-tool-catalog` 尚未挂载本包，因此生成的目录不会列出这三个 schema；本包 README 记录了它们。
- **没有投递回执** — 持久记录只表明 follow-up 已排队，不代表模型已回答或人已阅读。
- **宿主侧状态** — 计划保存在唤醒域而不是会话日志中，因此读取冷历史不会暴露它，它也不会随 fork 一起带走。
- **狭窄的重启重复窗口** — 在 follow-up 已排队但推进后的记录尚未持久化之间发生崩溃，重启后可能重复那一次唤醒。
- **加载顺序边界** — 插件不会接管加载时已经存活的 agent。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未确定的开放方向。通过 `ctx.agents.resume` 唤醒冷的持久会话，是实现"即使未加载也能触发"的显然下一步，但它需要为调度器创建的 agent 给出所有权与处置答案，因为 Web 宿主之后可能自行恢复同一会话。把这些 schema 采集进生成的工具目录也尚未完成。这两个方向都还没有计划或设计负责人。

</details>
