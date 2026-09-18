# Agent Note: 由 agent 设置的唤醒计划

Status: implemented

[English](2026-09-18-profile-wake-scheduler.md) | 中文

## 问题

一个承诺"我每 30 分钟检查一次"的 agent，如今只能通过启动后台 job 并等待其完成通知来兑现这一承诺。该通知不会唤醒空闲会话：完成通知会排队，并与下一条人类消息一起批量到达。三个分别安排在 30、60 和 120 分钟后的 job 都准时触发，而三条通知却在约两小时后一起送达，并附着在一条用户消息上。恰恰在周期性工作本应发生的时刻，会话保持沉默。

会话本地 Schedule 包已经能从 live owner 发起回合，但它的记录由模型工具调用创建并保存在会话日志中；此前无法在 profile 中声明"每隔 N 分钟说这句话"。第一种形态只读取 profile 配置并手工绑定一个会话 id，完全不可用：改动间隔就要编辑 `cordis.patch.yml`，而且每次修改都需要重启。

## 决策

`@knyazevai/dsh-wake-scheduler` 会在每个活跃根 agent scope 中注册三个面向 agent 的工具。`wake_schedule_set` 为调用方会话写入一份持久计划，`wake_schedule_status` 报告它，`wake_schedule_cancel` 停止它；会话来自持有该工具的 agent scope，而绝不来自参数，因此"每半小时起来一次"既不需要改 profile，也不需要重启。到期的计划会通过 `agent.followup(createUserMessage(...))` 发起一个普通回合，这正是人类消息所走的同一条 follow-up 边界。

该改动是增量的，并保持上游文件不被触碰：

- 插件是一个新的 workspace 包；不修改任何核心包，也不新增 loop 扩展点。
- 它只使用现有接缝：`tools` 注册表、`agent/created`、`agent.followup` 与 `ctx.storageDomain`。
- 持久计划存放在新的 `wake_scheduler` 存储域（表 `schedules`）中，而不是会话日志中，因此不新增会话事件类型，`SESSION_FORMAT_VERSION` 也不变。
- 由 `Config` 预置的 profile 回退是可选的，且默认关闭；agent 设置或取消的记录始终优先于它。

补发只取最近一次，并且可见。已存储的未来目标会被精确遵守；已经过去的目标——进程曾经停止，或会话曾经是冷的——只产生一次立即补发回合，并记录被合并的间隔数；`wake_schedule_status` 会以 `skippedIntervals` 与 `overdue` 报告它。失败的 follow-up 不写入任何内容，并在一个间隔后重试，因此损坏的目标不会空转。

## 备选方案

**只发布带手写会话 id 的 profile 配置计划。** 这是最初形态，已作为 UX 否决：每次改动间隔都要编辑 `cordis.patch.yml` 并重启 harness，而且所有者还要知道并粘贴会话 id。

**扩展 `@knyazevai/dsh-schedule`，加入配置驱动的记录创建。** 已否决：`schedule` 是上游代码，出现在最近一次上游合并的两个合并父提交中，因此修改它会形成长期冲突面。由另一个插件追加它的 `schedule/change` 事件，也会侵入另一个包的事件命名空间，并让不认识该类型的构建无法读取会话。

**复用后台 job 通知路径。** 已否决：该路径正是观察到的故障本身。它的通知不会唤醒空闲 driver，而让它们唤醒会改变现有 job 行为，这是本请求明确禁止的。

**把计划作为新的会话事件类型持久化到会话日志。** 已否决：未知的 `SessionEventMap` 成员在读取时是必填的，因此本构建写入的日志会被没有该插件的构建拒绝，除非该事件被标记为 `ignorable`。把宿主侧运行状态放进 `storageDomain` 可以保持会话格式稳定。

**通过 `ctx.agents.resume` 唤醒冷的持久会话。** 已推迟，而非否决：这样在运行进程中无人打开该会话时也能触发唤醒，但它需要为调度器创建的 agent 给出所有权与处置答案，因为 Web 宿主之后可能自行恢复同一会话。冷场景改由下次加载时的补发回合覆盖。

## 后果

agent 现在自己掌握节奏：只要挂载了 overlay，并且该会话在运行中的 `dsh` 进程里被打开过，设置好的计划就会在没有浏览器、没有用户消息的情况下触发，agent 还可以在同一会话中查看或停止它。计划能跨重启保留，而在唤醒到期时处于关闭状态的会话，会在下次加载时恰好收到一个补发回合，而不是积压。

已接受的代价：宿主侧记录不会随 fork 一起带走，也不会出现在冷历史中；在 follow-up 与推进后的持久记录之间发生崩溃可能重复一次唤醒；而一个再也不会被加载的会话永远不会收到补发回合，因为不存在外部通道。

覆盖情况：`tests/scheduling.spec.ts` 固定运算与状态视图，`tests/runtime.spec.ts` 针对模拟的会话层固定"每个间隔一个回合"、补发、隔离与处置，`tests/tools.spec.ts` 固定 set/status/cancel 的校验与持久变更，`tests/plugin.spec.ts` 固定回退预置、工具优先于配置、取消以及重启补发。五个源码文件都达到逐文件 100% 的语句、分支、函数与行覆盖。把这些 schema 采集进生成的工具目录，以及子进程真实组合测试，仍然缺失。
