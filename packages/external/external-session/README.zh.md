# @deepseek-ai/dsh-external-session

[English](README.md) | 中文

外部交互式 agent（智能体）会话 Service Definition。负责定义 `ctx.externalSessions` 服务约定（[`ExternalSessionsService`](src/types.ts)）：一个按命名注册的提供方注册表，其提供方代表外部 agent 进程（Codex、Claude Code、ACP 客户端）驱动实时会话，此外还负责在 start 时交给提供方的按会话 bridge。作为[能力 seam 拆分](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)中的 Service Definition 角色，它只依赖 cordis、品牌化 ID 原语、会话信封类型与 harness 错误基类——绝不依赖具体的外部 agent 或其线协议。第一个提供方（`external-session-codex`）与宿主 bridge 驱动是单独的程序包，消费该 seam 的约定。设计与阶段排期见[外部交互式 agent 会话规范说明](../../../.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md)。

用一句话概括约定：注册表把唯一的提供方名称（`provider`，也是会话 mode id）映射到 [`ExternalSessionProvider`](src/types.ts) 实现；`start(request)` 解析提供方、记录会话到提供方的路由，并把实时 [`ExternalBridgeContext`](src/types.ts) 交给它——`appendEvent`（仅日志的会话事件）、`requestPermission`（询问人类）、`streamDelta`（仅实时的增量）、以及 `disposal` 信号。后续调用——`prompt`、`interrupt`、`setModel`、`dispose`——只接收会话 id 并分发给所属提供方。

注册表按 effect 作用域实现 HMR 安全：`registerProvider(provider)` 返回确切的 Cordis effect disposer。移除提供方会阻止新的启动，但不会撤销已交给持有者的实时会话。

## 注册表

- `listAgents()`——每个已注册提供方的描述符，按插入顺序（`provider`、`label`、`modelDirectory`）。label 供 mode 选择器使用；中文产品文案位于客户端。
- `registerProvider(provider)` / `getProvider(name)` / `list()`——注册表表面；注册按 effect 作用域进行，并发出 `external/provider-added` / `external/provider-removed`。
- `modelDirectory`——`'provider'`（原生目录）或 `'config'`（由提供方持有的已校验目录）。`listModels(provider)` 始终分发给指定提供方，由提供方从其目录所指向的任一表面作答。

Mode 不是预设：选择某一个 mode 会在同一宿主进程中组合，并固定该会话的后端驱动。带 `mode` 的会话创建属于后续宿主阶段；本程序包在 `start` 时接收预先保留的 [`SessionId`](../../core/session/)，绝不会自行编造。

## Bridge

`start` 为每个会话向提供方提供一个 [`ExternalBridgeContext`](src/types.ts)：

- `appendEvent(sessionId, event)`——在注册了实时会话时，把写方事件片段写入持久会话日志（仅日志，`ignorable: true`）；否则丢弃。序号与 `ignorable` 标记由会话加盖，而非调用方。
- `requestPermission(sessionId, ask)`——在未接入任何权限通道时故障关闭（拒绝 `PERMISSION_UNWIRED`）；ask-user bridge 是宿主的职责。
- `streamDelta(sessionId, turnId, delta)`——仅转发的实时增量，绝不持久化。
- `disposal`——一个 `AbortSignal`，在会话被 dispose 时触发，让提供方能够拆解其进程。

## 事件

本程序包的上下文事件：`external/provider-added` 与 `external/provider-removed` 承载注册表↔描述符的转换。

持久化 `external/*` 会话日志事件词汇（session-started、turn-started、message-added、tool-activity、permission-asked/decided、model-switched、compaction-noticed、turn-ended、session-ended）由后续阶段合并进会话 `SessionEventMap` 并投影以供重放；本程序包仅通过 `appendEvent` 路由它们，不规定其名称。

## 模型体验

### 外部 agent 活动，仅日志

#### 模型看到的内容

什么也看不到。外部 agent 的转写、工具活动、权限结果与压缩（compaction）通知被记录为仅日志的 `external/*` 会话事件（`ignorable: true`）以供重放投影；它们不会织入 DSH 父会话的请求上下文、提示词或工具 schema。

#### Token 影响

直接的 token 影响为零：本注册表及它所路由的仅日志活动不会向任何 DSH 会话增加请求 token。

#### KV Cache 影响

无影响：这些事件在任何模型请求之外追加，且不与任何请求共享前缀，因此本程序包记录的任何内容都不会令 KV Cache 失效或重塑复用。

## 已知限制与暂缓事项

- **无流式持久化保证**——实时转写增量仅通过 `streamDelta` 走实时帧路径，绝不写入持久日志；重放重建已提交的 `external/*` 单元，而非帧增量。
- **权限语义与提供方无关且故障关闭**——在 ask-user 权限 bridge 落地之前，`requestPermission` 会以 `PERMISSION_UNWIRED` 拒绝；最终决策按 ask 应用，且不会对照未打开的 DSH turn 进行审计（阶段 1 没有原生 `approval/asked` 配对）。
- **持久化与实时 bridge 的接线由宿主负责**——`appendEvent` 仅在注册了实时会话时写入，而帧通道与 ask-user 接线是后续宿主程序包的职责，而非该 Service Definition。
- **此处无 Config**——提供方配置（command、roster、dispose 宽限期）由每个提供方程序包自行校验；该 seam 不传递任何可调参数。
