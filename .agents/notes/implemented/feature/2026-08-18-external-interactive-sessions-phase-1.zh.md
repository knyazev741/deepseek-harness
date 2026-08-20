# Agent Note: 外部交互式会话 — 第 1 阶段

Status: implemented

[English](2026-08-18-external-interactive-sessions-phase-1.md) | 中文

## 问题

框架运行自身的 agent 循环；控制台编码智能体是一次性子代理提供者，会把子运行折叠为单个工具结果。用户无法打开由外部智能体驱动的会话：多轮延续、实时流式输出、智能体自身的压缩与模型切换、以及权限提示都没有出口。本注记录外部交互式会话家族第 1 阶段的落地结果；设计意图保存在[外部交互式智能体会话](../proposed/feature/2026-08-18-external-interactive-agent-sessions.md)建议稿中，而[claude-code 与 codex subagent 后端](2026-08-04-claude-code-and-codex-subagent-backends.md)负责单发兄弟特性。

## 决策

**模式**（mode）决定由谁驱动会话：`dsh`（原生 agent 循环）或一个已注册的外部智能体。模式是创建时的客户端平面选择，持久地盖章在会话头部（默认 `dsh`）。第 1 阶段交付 Codex 方言；ACP 与 Claude Code 方言属于后续阶段。

第 1 阶段已定稿的包与职责：

- `packages/external/external-session` — 服务定义 `ctx.externalSessions`（具名提供者注册表，类似 `ctx.subagents`），外加 `ExternalSessionProvider` 契约与 `ExternalBridgeContext`。`compact()` 属于提供者契约的一部分：框架绝不在线路上重新实现智能体自身压缩。
- `packages/external/external-session-bridge` — 宿主机侧驱动：负责每个外部会话的提供者生命周期，通过 Task-1 桥追加仅日志的 `external/*` 事件，投影转录本，并在会话关闭时释放提供者。
- `packages/external/external-session-codex` — Codex 提供者，持久地驱动 `codex app-server --stdio`（以 `@openai/codex@0.147.0` 钉证据）。
- `packages/interaction/external-permission` — 第 1 阶段权限桥：把 `bridge.requestPermission` 路由到 ask-user/user-questions 通道，并携带权限形状的询问；在关闭/超时/无应答者时默认失败关闭。
- `packages/client/ui-session-mode` — 客户端插件：带模型席位的模式选择器，以及外部转录本会话节点。

以外部模式并携带已注册提供者创建会话时，会启动桥而绝不会创建原生 Agent；未知模式在创建时响亮失败。无模式（`dsh`）的会话不受影响。

### `external/*` 会话事件

驱动通过 `SessionEventMap` 声明合并追加仅日志事件，全部 `ignorable: true`（读取时的未知 `external/*` 不会损坏重放）。实况帧增量在帧通道上传输而不持久化（`streamDelta` 绝不记录）。仅提交单元：

`external/session-started`、`external/turn-started`、`external/message-added`、`external/tool-activity`、`external/permission-asked`、`external/permission-decided`、`external/model-switched`、`external/compaction-noticed`、`external/turn-ended`、`external/session-ended`。

`/compact` 与 `/model` 按会话模式路由：压缩调用提供者的原生压缩并记录 notice；模型切换调用 `setModel` 并记录切换。外部模式下的未知斜杠命令作为提示文本透传。

## 第 1 阶段与 approval seam

第 1 阶段通过 ask-user 交互通道由人类应答每个子权限提示（外部会话没有打开的 DSH 轮次）。智能体驱动的外部会话——作为子代理子级授权并让权限请求经 `ctx.approval` 及审计对路由——属于后续阶段；两条路径的审计语义不得分叉，且后续路由应取代而非分叉它们。

## 备选方案

设计备选方案及其否决在[外部交互式智能体会话](../proposed/feature/2026-08-18-external-interactive-agent-sessions.md)建议稿中论证：PTY 终端适配器（无结构化流、无日志投影、无策略继承）、就地扩展现有一次性子代理提供者（其契约是单个最终文本）、为一切使用单一通用线路（ACP 会丢失 Codex 线程恢复与 Claude Code `canUseTool` 细节）、以及把整个任务交给社区适配包（权限、沙箱、MCP 决策仍由框架掌控）。按计划的排序说明，第 1 阶段先交付 Codex 方言；ACP 是第 2 阶段的线路。

## 后果

用户可以在本 GUI 中打开由外部智能体驱动的会话：流式轮次渲染在同一个会话 UI 并从持久日志重放，模式选择器列出带各自模型目录的模式，模型切换驱动子方，渲染的权限提示以失败关闭的关闭/失败路径门控子方，且子方在框架沙箱下运行并在会话关闭时释放整个进程树。第 1 阶段交付建议稿的验收标准 1–4；标准 5（智能体启动的授权 + `ctx.approval` 审计对）属于上述后续阶段。

外部事件仅日志且 `ignorable: true`，因此重放跨重载保持正确，读取时未知 `external/*` 不损坏重放；模型可见⟺已记录规则成立，因为外部内容在父会话中不可模型可见，且无父上下文影响。流式增量不持久。钉住的 Codex fixture 门控线路漂移。第 1 阶段 ask-user 通道与后续 `ctx.approval` 路由之间的审计语义不得分叉，且后者取代而非分叉前者。
