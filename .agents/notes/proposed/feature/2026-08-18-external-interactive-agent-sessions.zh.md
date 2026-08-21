# Agent Note: 外部交互式智能体会话（ACP 与原生方言）

Status: proposed

[English](2026-08-18-external-interactive-agent-sessions.md) | 中文

## 问题

本 harness 运行自己的 agent loop，而可选的 Web bundle 已经通过持久化 external session 提供 Codex dialect。讲 ACP 的客户端、Claude Code 的原生交互式 dialect 与智能体启动的外部会话仍需要保留各自线路的延续与授权语义。[Codex 与 Claude Code 后端](../../implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md)仍是独立的一次性 seam：其 continuation manager 在构造上就是进程内的，因此交互性无法回填到 `SubagentProvider.start()` 上。

## 提案

**模式（mode）**命名谁在驱动一个会话：`dsh`（原生 agent loop）或已注册的外部智能体。已经交付的 `codex` mode 是会话创建时的客户端平面选择，而非 preset；未来的 ACP 与 Claude Code mode 必须保留该选择，绝不回退到原生 Agent。

已经交付的 `packages/external/` 家族负责 provider registry、bridge、Codex wire、仅日志事件与权限 seam。本提案剩余范围是：

- `external-session-acp` —— 持久 ACP 客户端：一次 `session/new`，随后多轮 `session/prompt`；`session/update` 通知投影进会话日志；`session/request_permission` 桥接给用户；模型目录来自智能体通告的 `session/models`。这是剩余的 ACP 通用线路。
- `external-session-claude-code` —— ACP 有损处的 Claude Code 原生 dialect：SDK resume、`canUseTool`、原生压缩与模型切换。
- 智能体启动的会话 —— 通过 external principal 与 `ctx.approval` 授权，并使用与用户启动外部会话相同的审计对语义。

当前 bridge 追加携带 `ignorable: true` 的仅日志 `external/*` 事件；重放渲染 transcript，帧级增量只存在于实时路径。新的 ACP 与 Claude provider 必须遵守相同的事件所有权与「模型可见⟺已记录」规则。

策略继承仍由宿主拥有：子进程运行在 harness 每会话沙箱下，用户启动的权限请求使用 ask-user 通道，MCP 通过认证网关与显式工具 allowlist 暴露。智能体启动的会话仍需要经 `ctx.approval` 的授权路径与同一审计对。

压缩与命令保留已经交付的 Codex 语义：外部智能体拥有上下文压缩，`/compact` 映射到原生机制，provider slash 行不会进入原生 Agent command registry。ACP 与 Claude provider 需要在其线路支持时提供等价的原生操作。

智能体驱动的会话只有在授权与生命周期语义明确后才能复用该家族；当前 Codex Web profile 不挂载这个 provider。

### Phase 1 已确定的范围

Phase 1 提供 Codex dialect。已确定的实现名称是：`ctx.externalSessions` 位于 `packages/external/external-session`；宿主 bridge driver 位于 `packages/external/external-session-bridge`；Codex provider 位于 `packages/external/external-session-codex`（证据固定为 `@openai/codex@0.147.0`）；Phase 1 ask-user 权限 bridge 位于 `packages/interaction/external-permission`；客户端插件（mode picker 与 external transcript nodes）位于 `packages/client/ui-session-mode`。会话创建时会把 mode 持久写入 header，默认值为 `dsh`。

## 备选方案

- **基于 `packages/terminal` 的 PTY 终端适配器：** 否决——没有结构化流、没有会话日志投影、没有策略继承；转录将是一段录像而非数据。
- **在既有一次性 subagent provider 上原地扩展：** 否决——其契约是一段最终文本；交互式会话由用户持有、多轮、寿命超过任何父 turn。[交互式侧会话](2026-07-08-interactive-side-sessions.md)从用户驱动侧以同样理由否决了 subagent seam。
- **单一通用线路覆盖一切：** 否决——ACP 丢失 Codex 线程恢复与 Claude Code `canUseTool` 细节；方言保留。
- **整体依赖社区适配包：** 作为政策否决——采用 ACP 线路可以，但权限、沙箱与 MCP 决策保持 harness 自有。

## 验收标准

- ACP mode 通过现有 conversation UI 流式输出并重放多轮会话，暴露其 model directory，并在不进入原生 Agent loop 的情况下路由原生压缩与权限请求。
- Claude Code mode 保留 SDK resume、`canUseTool`、原生压缩、模型切换、sandbox 约束和进程树处置，并持久投影 `external/*` 事件。
- 智能体启动的外部会话拥有明确 principal 与授权路径；权限请求经过 `ctx.approval`，并产生与用户启动审批相同的成对审计事件。

## 风险

- 线路漂移：ACP 会演进，Codex app-server 协议以 0.147.0 证据钉定；每个新增 provider 都需要 schema 证据与钉定 fixture。
- 原生 dialect 在授权与恢复语义上不同；provider 不得静默回退到 Codex 或原生 DSH 路径。
- 智能体启动授权可能暴露父级工具；principal 作用域与共享审计对必须在 dispatch 前保持有效。
- 纯 TUI 智能体没有受支持的线路；在出现 ACP 适配器或稳定协议前保持范围外。
