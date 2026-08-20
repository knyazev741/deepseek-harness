# @deepseek-ai/dsh-external-session

[English](README.md) | 中文

外部交互式 agent（智能体）会话 Service Definition。负责定义 `ctx.externalSessions` 服务约定（[`ExternalSessionsService`](src/types.ts)）：一个按命名注册的提供方注册表，其提供方代表外部 agent 进程（Codex、Claude Code、ACP 客户端）驱动实时会话，此外还负责在 start 时交给提供方的按会话 bridge。作为[能力 seam 拆分](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)中的 Service Definition 角色，它只依赖 cordis、品牌化 ID 原语、会话信封类型与 harness 错误基类——绝不依赖具体的外部 agent 或其线协议。第一个提供方（`external-session-codex`）与宿主 bridge 驱动是单独的程序包，消费该 seam 的约定。设计与阶段排期见[外部交互式 agent 会话规范说明](../../../.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md)。

用一句话概括约定：注册表把唯一的提供方名称（`provider`，也是会话 mode id）映射到 [`ExternalSessionProvider`](src/types.ts) 实现；`start(request)` 解析提供方、记录会话到提供方的路由，并把实时 [`ExternalBridgeContext`](src/types.ts) 交给它——如果存在实时 SessionStore，还会提供 `principal` 及其持久 recorder；此外还有 `appendEvent`（仅日志的会话事件）、`requestPermission`（询问人类）、`streamDelta`（仅实时的增量）、以及 `disposal` 信号。recorder 会在 API 入口同步脱离调用方拥有的每个值，接受每个 branded call id 各一个有界 JSON 调用和匹配结果，依次写入 `external/tool-call` 与 `external/tool-result`；它不会伪造原生 Agent 或轮次。它从所属会话日志播种 call id 唯一性，因此 resume 与 HMR 挂接不能重新打开已提交的 id。`streamDelta` 发出类型化的 `external/session-delta` Cordis 事件；该服务不导入也不依赖宿主 mux。`resume(request, providerThreadId)` 是针对持久提供方身份的独立显式挂接路径；它绝不会回退到 `start` 或创建替代线程。后续调用——`prompt`、`interrupt`、`compact`、`setModel`、`dispose`——只接收会话 id 并分发给所属提供方。`compact` 运行提供方的原生上下文压缩（外部模式下的 `/compact` 映射到这里）；原生表面缺少该操作的提供方会大声拒绝。

`ExternalProviderThreadId` 是传给 `resume` 的品牌化不透明值。可信的提供方 wire 输出变成类型化值时使用 `ExternalProviderThreadId(value)`；读取持久 JSON 或其他无类型输入时使用 `parseExternalProviderThreadId(value)`。注册表不持久化或渲染该值，也不会从提供方路径推断它。

`ExternalSessionStartRequest` 接受可选的 `sandbox` 与 `approvalPolicy`；注册表在调用提供方前将它们解析为 `read-only` 与 `ask`，而 `model` 与 `reasoningEffort` 仍是提供方侧的选择。注册表会在等待启动前发布提供方路由与 disposal 信号，启动拒绝时回滚两者，因此失败的启动不会留下陈旧的分发路由。dispose 会先 abort，再等待进行中的 start 或 resume 结算，然后销毁 external scope 与提供方；并发 dispose 调用共享同一份 quiescence Promise。提供方的 `setModel` 必须只接受其 `listModels` 目录中的 id，或明确说明另一项权威目录。

注册表按 effect 作用域实现 HMR 安全：`registerProvider(provider)` 返回确切的 Cordis effect disposer。移除提供方会阻止新的启动，但不会撤销已交给持有者的实时会话。

`start` 与 `resume` 按会话 id 共享一个进行中的挂接操作。因此并发调用会收到同一份启动结果；操作拒绝时会移除路由与 disposal 信号，后续尝试可以重新开始。提供方只会在路由预留后收到已解析的请求，因此 prompt 与 dispose 竞态仍由同一生命周期拥有。

## 注册表

- `listAgents()`——每个已注册提供方的描述符，按插入顺序（`provider`、`label`、`modelDirectory`）。label 供 mode 选择器使用；中文产品文案位于客户端。
- `registerProvider(provider)` / `getProvider(name)` / `list()`——注册表表面；注册按 effect 作用域进行，并发出 `external/provider-added` / `external/provider-removed`。
- `modelDirectory`——`'provider'`（原生目录）或 `'config'`（由提供方持有的已校验目录）。`listModels(provider)` 始终分发给指定提供方，由提供方从其目录所指向的任一表面作答。

Mode 不是预设：选择某一个 mode 会在同一宿主进程中组合，并固定该会话的后端驱动。带 `mode` 的会话创建属于后续宿主阶段；本程序包在 `start` 时接收预先保留的 [`SessionId`](../../core/session/)，绝不会自行编造。

## Bridge

`start` 为每个会话向提供方提供一个 [`ExternalBridgeContext`](src/types.ts)：

- `appendEvent(sessionId, event)`——在注册了实时会话时，把写方事件片段写入持久会话日志（仅日志）；否则丢弃。序号由会话加盖，事件所属方的持久化约定负责提供 `ignorable` 标记。
- `requestPermission(sessionId, ask)`——咨询已注册的权限通道，在未注册任何通道时故障关闭（拒绝 `PERMISSION_UNWIRED`）；ask-user bridge 是宿主的职责。`registerPermissionChannel(answerer)` 注册该通道，像 `registerProvider` 一样按 effect 作用域且 HMR 安全：同一时刻最多激活一个，dispose 它即恢复故障关闭的默认行为。
- `streamDelta(sessionId, turnId, delta)`——为宿主 mux 发出一条 `external/session-delta` Cordis 事件，仅转发且绝不持久化。
- `principal`——限定在实时会话内的外部执行身份。它的 recorder 校验无损 JSON、执行完整记录的字节上限，拒绝格式错误、无匹配、名称错误或重复的 call/result id，并从已提交的会话事件播种唯一性索引。
- `disposal`——一个 `AbortSignal`，在会话被 dispose 时触发，让提供方能够拆解其进程；注册表会在提供方启动达到 quiescence 后才 teardown。

提供方应把 `disposal` 当作待处理工作的取消信号：审批询问与启动操作必须结算，且在 `external/session-ended` 之后不得追加决策。

## 事件

本程序包的上下文事件：`external/provider-added` 与 `external/provider-removed` 承载注册表↔描述符的转换；`external/session-delta` 承载一条提供方轮次的实时增量并交给宿主 mux。

持久化 `external/*` 会话日志事件词汇（session-started、turn-started、message-added、tool-activity、tool-call/result、permission-asked/decided、model-switched、compaction-noticed、turn-ended、session-ended）已合并进会话 `SessionEventMap` 并投影以供重放；本程序包路由 recorder 所有的工具配对事件及其他事件，不重复规定名称。

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
- **权限语义与提供方无关且故障关闭**——在通过 `registerPermissionChannel` 注册权限通道之前，`requestPermission` 会以 `PERMISSION_UNWIRED` 拒绝；最终决策按 ask 应用，外部请求会以 `external/approval-asked` 与 `external/approval-decided` 配对审计，不要求伪造原生 DSH turn。
- **持久化与实时 bridge 的接线按所有权拆分**——`appendEvent` 仅在注册了实时会话时写入；该 Service Definition 发出 `external/session-delta`，宿主 API 将其投影为 `external/delta` mux 帧给已订阅的客户端；ask-user 接线仍由宿主负责。
- **恢复身份由提供方拥有**——注册表不保存线程 id，也不会从路径或事件推断它；宿主读取不透明的持久 id，并在物化冷会话时调用显式的 `resume`。
- **此处无 Config**——提供方配置（command、roster、dispose 宽限期）由每个提供方程序包自行校验；该 seam 不传递任何可调参数。
- **Recorder 只记录已提交的值**——每个调用和结果都会在 recorder API 边界同步通过 session JSON 边界脱离原对象，并限制为 64 KiB UTF-8 事件数据；过大的值或非 JSON 值会在日志发生变化前失败，格式错误的持久历史会在挂接时故障关闭。
