# Agent Note: Fork Host overlay 的所有权与有界运行时接缝

Status: implemented

[English](2026-08-22-fork-host-overlay.md) | 中文

## 问题

Fork 增加了仅 Host 的来源信息和工作区导航状态，同时 core session 与 model-visible surface 继续和 upstream 共用。这些事实需要持久化所有权、可重放的准入和按 fiber 顺序的 teardown，但不能变成 session header 字段、prompt context 或 API Proxy 方法。

## 决策

Fork Host overlay 由两个可选包拥有。`@deepseek-ai/dsh-fork-session-source` 观察权威的 session 创建流程，追加一个带有 `{ source: 'github-actions' }` 的 `fork/session-source` 事件，并注册可空的 `forkSessionSource` projection。事件使用 core 的 `LogIntent` 接缝传入 `{ ignorable: true }`，因此没有加载该可选词汇的 reader 可以跳过部署元数据并保留 session；surface event 不能请求这个标记。

`@deepseek-ai/dsh-fork-workspace-session-state` 在 `fork-workspace-session-state` Settings namespace 中拥有有序的全局 pin 列表，只暴露生成的 `forkWorkspaceSessionState` Remote 及其 `list`、`setPinned` 方法。持久化值只包含 `pins.sessionIds`；Settings descriptor revision 是唯一的 CAS 权威值。串行 operation queue 在 stale 检查前读取当前 descriptor，只允许当前 workspace member 进行 mutation，并在其嵌套的 Settings registration withdraw 之前完成 drain。

Core session 接缝保持有界：`LogIntent` 只为 log-only event type 标记 ignorable envelope；`SurfaceIntent` 仍负责 surface placement，且不能请求 `ignorable`。两个 fork 包都不贡献 model context、prompt content 或 API Proxy 方法，普通 profile 也不会挂载它们。

## 验证

Session-source 测试覆盖 event marker、projection 和 effect 所有权的 withdraw。Workspace service、invariant 和 Loader composition 测试覆盖持久化、revision CAS、准入、有序 mutation、精确 Remote 方法集合和 teardown；延迟 persist 生命周期测试证明排队工作完成前 namespace 仍然可用。生成的 Remote 在声明的 built-artifact lane 中检查，而不是由 source-plane 测试运行时加载生成文件。

## 考虑过的替代方案

**Core session header 字段。** Header 字段会把部署来源变成共享 core 格式的一部分，也无法提供可选 reader 行为。只写入 log-only event 可以隔离 fork 词汇并支持重放。

**只使用 Settings 记录来源。** Settings 是可变的 Host 配置，不是追加式 session history。Session-created event 在权威生命周期点保留事实，并驱动 projection。

**Model-visible pin context 或 API Proxy 方法。** Workspace pin 是 Host 导航状态，不是 model input 或 upstream request capability。生成的 Remote 让功能保持可选，同时不修改共享 surface。

**没有 revision 或并发 pin 写入。** 直接写入可能覆盖竞争更新并丢失顺序。Settings revision 与串行 queue 让 stale admission 和写入冲突显式化。

## 后果

Fork Host overlay 可以独立组合和移除，同时不改变 core session format 与 model request。只有 producer 提供了明确标记，未知 source event 才能安全跳过；任何影响 reconstruction 的未来 fork event 都必须使用 required event 或另行评审的 core 接缝。Workspace membership 改变时已有 pin 仍保持持久化，因此 membership 是准入规则而不是清理不变量。
