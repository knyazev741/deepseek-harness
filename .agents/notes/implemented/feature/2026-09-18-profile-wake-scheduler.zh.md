# Agent Note: 由 profile 配置的唤醒调度器

Status: implemented

[English](2026-09-18-profile-wake-scheduler.md) | 中文

## 问题

一个承诺"我每 30 分钟检查一次"的 agent，如今只能通过启动后台 job 并等待其完成通知来兑现这一承诺。该通知不会唤醒空闲会话：完成通知会排队，并与下一条人类消息一起批量到达。三个分别安排在 30、60 和 120 分钟后的 job 都准时触发，而三条通知却在约两小时后一起送达，并附着在一条用户消息上。恰恰在周期性工作本应发生的时刻，会话保持沉默。

会话本地 Schedule 包已经能从 live owner 发起回合，但它的记录由模型工具调用创建并保存在会话日志中。此前无法在 profile 中声明"每隔 N 分钟说这句话"，并让它无需用户回合就能启动。

## 决策

`@knyazevai/dsh-wake-scheduler` 是 `schedule` 组中一个新的可选启用函数插件。它读取一份 profile 配置——`enabled`、`intervalMinutes`、`prompt`、可选的 `sessionId` 与可选的 `startDelayMinutes`——并通过调用 `agent.followup(createUserMessage(...))`，在每个匹配的活跃根会话中按间隔发起一个普通回合；这正是人类消息所走的同一条 follow-up 边界。

该改动是增量的，并保持上游文件不被触碰：

- 插件是一个新的 workspace 包；不修改任何核心包，也不新增 loop 扩展点。
- 它只观察 `agent/created`，且只驱动公开的 Agent 方法，因此不会向 agent loop 或 job 通知路径添加任何内容。
- 持久的下次运行游标存放在新的 `wake_scheduler` 存储域（表 `cursors`）中，而不是会话日志中，因此不引入任何会话事件类型，也不改动 `SESSION_FORMAT_VERSION`。
- 默认关闭；只有启用该 profile 配置，它才会做任何事。

补发只取最近一次：已存储的未来目标会被精确遵守，而已经过去的目标只产生一次立即唤醒，而不是重放。失败的 follow-up 不写入游标，并在一个间隔后重试。已触发的唤醒会依据计算出的目标设置下一个定时器，而不是在持久写入之后重新读取游标，因此写入失败不会产生第二次立即唤醒。

overlay 位于 `apps/cli/config/examples/wake-scheduler/cordis.yml`。`apps/cli` 声明了该包，`tsconfig.base.json` 也为其建立了映射，因此示例 overlay 在 tsx 源码启动下解析到 workspace 源码，而不依赖构建产物 `lib/`。

## 备选方案

**扩展 `@knyazevai/dsh-schedule`，加入配置驱动的记录创建。** 已否决：`schedule` 是上游代码，出现在最近一次上游合并的两个合并父提交中，因此修改它会形成长期冲突面。由另一个插件追加它的 `schedule/change` 事件，也会侵入另一个包的事件命名空间，并让不认识该类型的构建无法读取会话。同级包则让上游代码保持原样。

**复用后台 job 通知路径。** 已否决：该路径正是观察到的故障本身。它的通知不会唤醒空闲 driver，而让它们唤醒会改变现有 job 行为，这是本请求明确禁止的。

**把游标作为新的会话事件类型持久化到会话日志。** 已否决：未知的 `SessionEventMap` 成员在读取时是必填的，因此本构建写入的日志会被没有该插件的构建拒绝，除非该事件被标记为 `ignorable`。把宿主侧运行状态放进 `storageDomain` 可以保持会话格式稳定。

**通过 `ctx.agents.resume` 唤醒冷的持久会话。** 已推迟，而非否决：这样在运行进程中无人打开该会话时也能触发唤醒，但它需要为调度器创建的 agent 给出所有权与处置答案，因为 Web 宿主之后可能自行恢复同一会话。

## 后果

该插件为引发它的问题场景补上了缺口：一旦 `dsh web` 启动且目标会话被打开过，Web 宿主会在进程生命周期内保持该 agent 存活，因此即使没有浏览器、没有用户消息，唤醒也会触发。它无法触达在运行进程中从未被打开过的会话，也没有外部通道。

已接受的代价：宿主侧游标不会随 fork 一起带走，也不会出现在冷历史中；在 follow-up 与持久游标之间发生崩溃可能重复一次唤醒；省略 `sessionId` 会调度加载后创建的每个根 agent，这对单会话 profile 是有意为之，对多会话则会出人意料。

覆盖情况：`tests/scheduling.spec.ts` 固定节奏运算，`tests/runtime.spec.ts` 针对模拟的会话层固定"每个间隔一个回合"、补发、隔离与处置，`tests/plugin.spec.ts` 固定配置校验与组合接线。三个源码文件都达到逐文件 100% 的语句、分支、函数与行覆盖。子进程真实组合测试或 Web e2e 仍然缺失：一分钟的最小间隔使"等待一次唤醒"的浏览器测试按现状不切实际。
