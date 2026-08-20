# Agent Note: External interactive sessions — Phase 1

Status: implemented

[English](2026-08-18-external-interactive-sessions-phase-1.md) | 中文

## Problem

Harness 运行自己的 agent loop；console coding agent 是一次性 subagent 提供方，会把子运行压缩成一个工具结果。用户无法打开由外部 agent 驱动的会话：多轮继续、实时流、agent 原生压缩、模型切换与权限询问都没有表面。本说明记录外部交互式会话家族的 Phase 1 落地；设计意图见[外部交互式 agent 会话规范说明](../../proposed/feature/2026-08-18-external-interactive-agent-sessions.md)，一次性兄弟实现见[Claude Code 与 Codex subagent 后端](2026-08-04-claude-code-and-codex-subagent-backends.md)。

## Decision

**Mode** 命名驱动会话的主体：`dsh`（原生 agent loop）或已注册的外部 agent。Mode 是创建时的 client-plane 选择，并持久写入会话 header（默认 `dsh`）。Phase 1 提供 Codex dialect；ACP 与 Claude Code dialect 属于后续阶段。

已确定的 Phase 1 程序包与职责：

- `packages/external/external-session`——`ctx.externalSessions` Service Definition（类似 `ctx.subagents` 的命名提供方注册表）以及 `ExternalSessionProvider` 与 `ExternalBridgeContext` 约定。`compact()` 属于提供方约定，Harness 不会跨 wire 重做 agent 原生压缩。
- `packages/external/external-session-bridge`——宿主侧 driver：按外部会话拥有提供方生命周期，通过 Task 1 bridge 追加仅日志的 `external/*` 事件，投影 transcript，并在会话关闭时 dispose 提供方。
- `packages/external/external-session-codex`——Codex 提供方，持久驱动 `codex app-server --stdio`（证据固定为 `@openai/codex@0.147.0`）。
- `packages/interaction/external-permission`——Phase 1 权限 bridge：把 `bridge.requestPermission` 路由到 ask-user/user-questions 通道，使用权限形状的询问；关闭、超时、无 answerer 时故障关闭。
- `packages/client/ui-session-mode`——客户端插件：带 model seat 的 mode picker 与外部 transcript conversation nodes。

使用已注册提供方的 external-mode 会话创建会启动 bridge，绝不会启动原生 Agent；未知 mode 在创建时大声失败。无 mode（`dsh`）的会话不受影响。

Codex 提供方把实时会话的 sandbox 与 approval fold 合并到每次 external start 或 resume。受限子进程收到精确的 app-server argv 与配置 state root 下的私有 `CODEX_HOME`；默认使用打包的 `@openai/codex` launcher，显式 command 是覆盖项。launcher 环境清洗环境中的凭证形状变量，同时保留显式提供的凭证。稳定的 `model` 与 reasoning `effort` 字段发送到 thread start/resume 与每轮；模型切换只有在原生目录中时才接受，并在下一轮前记录。成功的 `thread/start` 会把品牌化的不透明 `providerThreadId` 写入 `external/session-started`；可信 wire 输出在该边界构造成类型化值，持久输入解析后，冷会话使用显式的 `resume`/`thread/resume`，绝不回退到替代线程。宿主只在实时操作需要时通过 `SessionPersistence.prepare`、`SessionStore.enter` 与 `SessionStore.announce` 物化冷外部会话；history 与 list 保持无进程。start/resume 按会话去重，挂接失败会回滚实时路由，同时让持久日志保持可读。启动生命周期记录在第一次 await 前即可取消；dispose 会先 abort、等待挂接结算，并在共享的 quiescence Promise 上只 teardown 一次，因此不合作的延迟启动不会解析已 dispose 的会话。并发 prompt 串行化，待处理审批在 `external/session-ended` 前取消，清理失败保留在 quiescence 屏障上。子进程死亡会结算活动轮次、在终止前关闭 wire listener、等待进程树，然后使用内存线程 id 在同一提供方实例内重启子进程。会话创建前的模型目录使用明确的 read-only policy；read-only 忽略 state-root 的写授权。Loader 组合、浏览器与面向用户的快照验收证据延后到 Task 9。

### The `external/*` session events

Driver 通过 `SessionEventMap` declaration merging 追加仅日志事件，全部为 `ignorable: true`（读取时未知 `external/*` 不会破坏 replay）。实时 frame 增量通过 frame channel 传递，不持久化（`streamDelta` 永不写日志）。只提交以下单元：

`external/session-started`（包含不透明的提供方线程身份）、`external/turn-started`、`external/message-added`、`external/tool-activity`、`external/tool-call`、`external/tool-result`、`external/approval-asked`、`external/approval-decided`、`external/permission-asked`、`external/permission-decided`、`external/model-switched`、`external/compaction-noticed`、`external/turn-ended`、`external/session-ended`。

`/compact` 与 `/model` 按 session mode 路由：压缩调用提供方原生 compact 并记录 notice；模型切换调用 `setModel` 并记录切换。外部 mode 中未知 slash command 作为 prompt 文本传递。

### 外部工具所有权

实时外部会话提供带品牌化 id、session、作用域 context 与 recorder 的 `ExternalToolPrincipal`。recorder 会在 API 入口同步脱离调用方的嵌套值，为每条已提交记录限制 JSON 安全的大小，并从所属会话日志播种 call id 唯一性，覆盖 resume 与 HMR 挂接。已交付的 shell 与 filesystem 前台定义显式选择该身份，并从外部 session 派生 cwd、环境、观察和结果作用域，无需创建原生 Agent。后台 shell job 仍要求原生 Agent 所有权；ask-user、schedule、workflow、Cordis 自修改、terminal/jobs 与 subagent 工具定义对外部 principal 默认拒绝。Phase 1 权限 bridge 仍是由宿主拥有的 ask-user 路径，而不是外部工具 eligibility 授权。

## Alternatives considered

设计替代项及其否决理由记录在[外部交互式 agent 会话规范说明](../../proposed/feature/2026-08-18-external-interactive-agent-sessions.md)中：PTY terminal adapter 没有结构化 stream、日志投影与 policy inheritance；原地扩展一次性 subagent 提供方会违反其单一最终文本约定；一个通用 wire 无法表达 ACP 的 Codex thread resume 与 Claude Code `canUseTool` 细节；依赖社区 adapter pack 会把权限、sandbox 与 MCP 决策留在 Harness 之外。Phase 1 按计划先交付 Codex dialect；ACP 是 Phase 2 wire。

## Phase 1 vs the approval seam

外部路径现在使用带 external principal 与 branded 工具调用 id 的 `ctx.approval.requestExternal()`。它会记录成对的 `external/approval-asked` 与 `external/approval-decided` 事件，不会伪造原生 Agent 或轮次。缺少应答者、dispose、abort、格式错误的决定、元组不匹配、事件 session id 不属于所属 Session，或 `external/session-ended` 之后的决定都会故障关闭；两条记录必须使用完全相同的 principal、session 与 call id。ask-user 权限 bridge 仍是独立的、由宿主拥有的提供方权限询问路径。

## Consequences

用户可以在 GUI 中打开由外部 agent 驱动的会话：流式轮次显示在同一 conversation UI，并从持久日志 replay；mode picker 列出带各提供方模型目录的 mode；模型切换驱动子进程；渲染出的权限询问在故障关闭的关闭/失败路径上门控子进程；子进程在 Harness sandbox 下运行，并在会话关闭时回收进程树。Phase 1 现在完成规范说明的验收项 1–5；loader 组合、浏览器与面向用户的快照验收证据仍延后到 Task 9。

External 事件仅写日志且为 `ignorable: true`，因此 replay 在 reload 后仍正确，读取未知 `external/*` 不会破坏它；model-visible ⟺ logged 规则成立，因为没有外部内容进入父会话的 model 请求，也没有 parent-context effect。流式增量不持久化。固定的 Codex fixture 防止 wire 漂移。外部工具调用与结果按 branded call id 严格成对提交，每对记录限制为有界 JSON，并投影到 external transcript；格式错误、名称错误、重复、冲突、无匹配或有歧义的记录由 session invariant 拒绝或由防御性 projection 忽略，不会进入父 agent 的 model context。外部审批审计对同样只写日志，不是原生轮次或 Agent 状态。
