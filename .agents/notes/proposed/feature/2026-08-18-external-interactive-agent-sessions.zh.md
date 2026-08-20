# Agent Note: 外部交互式智能体会话（ACP 与原生方言）

Status: proposed

[English](2026-08-18-external-interactive-agent-sessions.md) | 中文

## 问题

本 harness 运行自己的 agent loop；控制台编码智能体（Codex、Claude Code、讲 ACP 的客户端）在这里仅作为一次性 subagent provider 存在（[Codex 与 Claude Code 后端](../../implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md)），把一次子运行收敛为一条最终 tool result。用户无法在本 GUI 中打开一个由外部智能体驱动的会话，之后智能体也无法托管这样的会话：多轮延续、实时流式输出、智能体原生压缩、斜杠命令、原生模型目录与权限请求都没有承载面。subagent seam 的 continuation manager 在构造上就是进程内的——外部进程无法进入其 inbox 契约——因此交互性无法回填到 `SubagentProvider.start()` 上。

## 提案

**模式（mode）**命名谁在驱动一个会话：`dsh`（原生 agent loop）或某个已注册的**外部智能体**（`codex`、`claude-code`、任意 ACP 客户端）。模式是会话创建时的客户端平面选择，而非 preset：选择器组合的是同一个宿主进程，模式只为该会话固定驱动后端。

新的能力族 `packages/external/`：

- `external-session` —— Service Definition（`ctx.externalSessions`）：启动与停止一个持久的外部会话、提交 prompt、流式输出智能体活动、呈现权限请求、列出模型、路由命令。一个带命名 provider 的注册表，与 `ctx.subagents` 同构。
- `external-session-acp` —— 持久 ACP 客户端：一次 `session/new`，随后任意多轮 `session/prompt`；`session/update` 通知投影进会话日志；`session/request_permission` 桥接给用户；模型目录在智能体通告时来自 `session/models`。这是主线路，覆盖 ACP 适配的客户端。
- `external-session-codex`、`external-session-claude-code` —— ACP 有损处的原生方言：可恢复的 Codex 线程与结构化审批、Claude Agent SDK 的 resume 与 `canUseTool`、原生压缩与模型切换 API。

会话日志：桥接驱动追加只记录的 `external/*` 事件（消息增量、工具活动、权限结果、压缩通知），携带 `ignorable: true`；重放渲染转录。外部内容都不进入模型可见面，因此「模型可见⟺已记录」规则天然成立，父上下文零影响。帧级增量按客户端 notifier 纪律合并。

策略继承，三层：子进程在本 harness 的每会话沙箱约束下生成，无论该智能体自身声明的沙箱如何；来自子进程的每个权限请求由人类通过 ask-user 交互通道回答（第一阶段没有打开的 DSH turn，而[审批 seam](../../implemented/feature/2026-07-06-approval-seam.md) 要求一个——智能体驱动的会话之后改走 `ctx.approval`，携带同一审计对）；MCP 暴露以网关形式落地，把选定的 `ctx.tools` 作为 MCP 服务器提供给子进程，使经 harness 中介的动作运行在 harness 策略之下。

压缩与命令：外部智能体拥有自己的上下文压缩——harness 绝不跨线重新实现；harness 的 `/compact` 命令映射到智能体原生机制并记录通知。命令命名空间区分 harness 命令与透传 prompt。

智能体驱动的会话通过一个构建在 `ctx.externalSessions` 之上的 `subagent` provider 复用同一能力族；会话本身不区分握方向盘的是人还是智能体。

### 第 1 阶段已定稿的落地面

第 1 阶段交付 Codex 方言。已定稿的实现名称：`ctx.externalSessions` 位于 `packages/external/external-session`；宿主机桥驱动是 `packages/external/external-session-bridge`；Codex provider 是 `packages/external/external-session-codex`（以 `@openai/codex@0.147.0` 钉证据）；第 1 阶段 ask-user 权限桥是 `packages/interaction/external-permission`；客户端插件（模式选择器 + 外部转录本节点）是 `packages/client/ui-session-mode`。会话的模式在创建时持久地盖章在头部，默认 `dsh`。

## 备选方案

- **基于 `packages/terminal` 的 PTY 终端适配器：** 否决——没有结构化流、没有会话日志投影、没有策略继承；转录将是一段录像而非数据。
- **在既有一次性 subagent provider 上原地扩展：** 否决——其契约是一段最终文本；交互式会话由用户持有、多轮、寿命超过任何父 turn。[交互式侧会话](2026-07-08-interactive-side-sessions.md)从用户驱动侧以同样理由否决了 subagent seam。
- **单一通用线路覆盖一切：** 否决——ACP 丢失 Codex 线程恢复与 Claude Code `canUseTool` 细节；方言保留。
- **整体依赖社区适配包：** 作为政策否决——采用 ACP 线路可以，但权限、沙箱与 MCP 决策保持 harness 自有。

## 验收标准

- 以外部模式创建的会话把各轮流式输出进同一会话 UI，刷新后从持久日志重放的结果一致，`/compact` 经智能体原生机制完成压缩并给出可见通知。
- 模式选择器列出外部模式及其模型目录；选择模型即切换子进程的模型。
- UI 中呈现的子进程权限提示对子进程具有门控作用；取消与失败路径一律 fail-closed。
- 子进程运行在 harness 沙箱策略之下；关闭会话即处置整个进程树。
- 智能体启动的外部会话以 subagent 子身份获得授权，其权限请求经 `ctx.approval` 路由并携带审计对。

## 风险

- 线路漂移：ACP 在演进，Codex app-server 协议以 0.147.0 证据钉定；升级必须经过 schema 版本化与钉定 fixture 测试的门控。
- 继承是策略形状的，而非同一的：在 MCP 网关落地之前，子进程自身的原生工具仍在 harness 中介之外。
- 流式外部事件增长会话日志；合并与留存需按 apply-limits 规则设定边界。
- 纯 TUI 智能体（目前的 Grok Build）没有线路；在出现 ACP 适配器或稳定线路协议之前保持范围外。
- 两条审批路径（第一阶段 ask-user 通道、之后的 `ctx.approval`）不得在审计语义上分叉；第三阶段路径应是取代而非分叉。
