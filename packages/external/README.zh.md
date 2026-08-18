# external/ — 外部交互式智能体会话族

[English](README.md) | 中文

本族允许会话由外部控制台智能体（Codex、Claude Code、讲 ACP 的客户端）而非原生 agent loop 驱动。会话创建时选择的**模式**命名一个已注册的 provider；模式是客户端平面的选择，而非 preset。设计与阶段划分见[外部交互式智能体会话 spec note](../../.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md)。

| Package | Role | ctx key |
|---|---|---|
| [`external-session/`](external-session/README.md) | Service Definition：命名 provider 注册表、会话分发、每会话桥接 | `ctx.externalSessions` |
| `external-session-codex/` | Codex 方言 provider（开发中；证据转录见 `tests/evidence/`） | registers on `ctx.externalSessions` |
| [`external-session-bridge/`](external-session-bridge/README.md) | 宿主侧驱动：在其模式下创建宿主会话时启动外部 provider、注册转录投影、会话关闭时销毁 | `ctx.externalSessions` + `ctx.sessionProjections` |

ACP provider 方言已在规划中；见 spec note 的阶段计划。
