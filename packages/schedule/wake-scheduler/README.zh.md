---
description: "可选启用的 profile 配置唤醒调度器：按间隔与提示词，在没有用户消息的情况下于匹配的活跃根会话中发起一个回合，面向需要在无人值守时周期性工作的所有者。"
kind: "package-reference"
---

# @knyazevai/dsh-wake-scheduler

[English](README.md) | 中文

## 概述

Wake Scheduler 按 profile 配置的间隔，在匹配的活跃根会话中发起一个普通回合；它走的是与人类消息完全相同的 follow-up 路径，因此不涉及后台 job，也不涉及通知投递。它存在的原因是：后台 job 的完成通知会在会话空闲时排队，只在下次人类活动时才出现，于是一旦没人向会话写入，"每 30 分钟检查一次"就会失效。调度器默认关闭，自身没有工具、没有模型可见的界面，也绝不离开会话：不发送电子邮件、短信、推送或浏览器通知。

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

当某个会话必须在无人照看的情况下持续工作——周期性检查、长时间观察、定时复核——并且该会话在运行中的 `dsh` 进程里保持活跃时，请选择 Wake Scheduler。当工作必须到达会话之外、当目标时刻进程可能已经停止、或者当你需要日历或 Cron 规则时，请不要使用它：这里的间隔是固定的整分钟。

### 启用 Wake Scheduler

挂载 overlay 并设置 profile 配置；在 `enabled` 为 `true` 之前，调度器始终处于惰性状态：

```sh
dsh web --patch apps/cli/config/examples/wake-scheduler/cordis.yml
```

```yaml
- insert:
    - id: wake-scheduler
      name: '@knyazevai/dsh-wake-scheduler'
      config:
        enabled: true
        intervalMinutes: 30
        prompt: 'Scheduled check-in: continue the plan and report anything that needs my decision.'
        # sessionId: session-...   # omit to schedule every root session
        # startDelayMinutes: 30    # first wake delay; defaults to intervalMinutes
```

成功的样子是：目标会话每 30 分钟出现一个新的用户回合，每个回合都带有插件来源标记，并伴随一行 `info` 日志，记录会话与运行次数。关闭的配置（也是默认值）会把插件加载为空操作，不打开任何存储，也不改变任何行为。

### 配置

| 字段 | 是否必填 | 含义 |
|---|---|---|
| `enabled` | 否（默认 `false`） | 是否运行调度器。为 false 时其余字段一律忽略。 |
| `intervalMinutes` | 启用时必填 | 两次唤醒之间的整分钟数，至少为 1。 |
| `prompt` | 启用时必填 | 调度器所发起回合的非空文本。 |
| `sessionId` | 否 | 把计划绑定到一个会话。省略时，加载后创建的每个根 agent 都会被调度。 |
| `startDelayMinutes` | 否 | 没有游标时，从加载到首次唤醒的整分钟数。默认等于 `intervalMinutes`。 |

启用后若缺少间隔或提示词为空，会在插件加载时明确失败，而不是静默地什么都不做。

### 重启后的行为

上一次与下一次唤醒的时刻存储在 `wake_scheduler` 存储域中，而不是会话日志中。重启后调度器会读回游标：仍在未来的目标会被精确遵守，已经过去的目标只产生一次补发唤醒。错过的间隔绝不会作为积压重放，一个间隔也绝不会产生多于一个回合。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 作用域与组合

插件声明 `inject = ['agents', 'storageDomain']`，是带有 `name` / `inject` / `Config` / `apply` 的函数插件。它只观察加载之后发布的 `agent/created` 事件，为每个匹配的根 agent 设置一个定时器，并在处置时通过 agent 自身的 scoped effect 撤销每个定时器。加载时已经存活的 agent 不会被接管，subagent 也永远不会被调度。

### 回合从何而来

到期的唤醒会调用 `agent.followup(createUserMessage({ content, source: { kind: 'plugin', plugin: 'wake-scheduler' } }))`。这是循环的普通 follow-up 边界：它排队一个正常的用户回合并唤醒 driver，绝不会 steer 或打断正在运行的工作。本包不会创建后台 job，不会追加私有的会话事件类型，也不会触碰 job 通知路径。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、`agent/created` 观察、游标域、按 agent 设置定时器 |
| [`src/runtime.ts`](src/runtime.ts) | live 定时器所有者：arm/disarm/dispose、单回合派发、诊断 |
| [`src/scheduling.ts`](src/scheduling.ts) | 纯节奏运算：校验、下次到期解析、补发、定时间隔分段 |

### 持久状态

`wake_scheduler` 域（版本 1，表 `cursors`）为每个会话 id 保存一条 `{ lastRunAt, nextRunAt, runs }` 记录。一次派发的唤醒会先持久化新游标，再重新设置定时器；定时器是按计算出的目标设置的，而不是重新读取得到的，因此游标写入失败不会产生第二次立即唤醒。写入只有在后端持久化之后才会 resolve，所以重启读回的是上一个间隔或已推进的间隔，绝不会是撕裂的值。

### 失败隔离

抛出异常的 follow-up 会被隔离：本次运行不推进游标、记录一条 `warn`，下一次尝试在一个完整间隔之后，从而避免热循环。游标写入失败也以同样方式隔离；已投递的回合仍然有效，下一个间隔照常继续。如果目标不再是注册表中该会话的活跃根 agent，就会被跳过。调度器的 `dispose` 会清除每个已设置的定时器，但不删除持久游标。

### 为什么没有 `./invariant` 伴随包

No invariant companion is published because 本包不读取任何可能与它所拥有的观测发生背离的第二种观测。每条写入路径都是一次同步的 `followup`，随后对同一个值做一次持久 `put`，因此没有可断言的独立观测；伴随包及其接线被省略，而不是空着发布。

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

### 计划唤醒回合

#### 模型看到什么

每个到期的间隔会排队一条普通的 user 角色消息，其文本就是所配置的 `prompt` 原文，并带有 `source: { kind: 'plugin', plugin: 'wake-scheduler' }` 标记。本包不添加工具 schema、不添加 system prompt 段落，也不添加任何其他模型可见输入。

#### Token 影响

每次唤醒都会添加一条依赖数据的用户消息，它会保留在会话历史中并贡献其 token，直到普通压缩将其移除。插件不会向请求前缀添加任何内容。

#### KV 缓存影响

唤醒会追加在既有历史之后，并保持已经可复用的前缀；只有被追加的消息取决于所配置的提示词。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限活跃进程** — 只有当被调度的会话是运行中 `dsh` 进程的活跃根 agent 时，唤醒才会触发。冷会话或已卸载的会话收不到任何东西，也不存在外部通道。
- **固定间隔，而非日历规则** — `intervalMinutes` 是以创建时刻为锚点的整分钟数；不支持 Cron 与星期规则。
- **默认广播** — 省略 `sessionId` 会调度加载后创建的每个根 agent；这对单会话 profile 是有意为之，对多会话而言则会出人意料。
- **没有投递回执** — 持久游标只记录 follow-up 已排队，不代表模型已回答或人已阅读。
- **宿主侧游标** — 下次运行状态存放在存储中而不是会话日志中，因此读取冷历史不会暴露计划，游标也不会随 fork 一起带走。
- **狭窄的重启重复窗口** — 在 follow-up 已排队但游标尚未持久化之间发生崩溃，重启后可能重复那一次唤醒。
- **加载顺序边界** — 插件不会接管加载时已经存活的 agent。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未确定的开放方向。通过 `ctx.agents.resume` 唤醒冷的持久会话，是实现"即使未加载也能调度"的显然下一步，但它需要为调度器创建的 agent 给出所有权与处置答案，因为 Web 宿主之后可能自行恢复同一会话。目前还没有计划或设计负责人。

</details>
