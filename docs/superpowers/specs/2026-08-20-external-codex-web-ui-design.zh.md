# External Codex Web UI 设计

[English](2026-08-20-external-codex-web-ui-design.md) | 中文

## 目标

本地单用户 Web profile 可以创建 `codex` session，并通过普通 DeepSeek Harness conversation UI 使用官方 Codex app-server。session 流式传输 assistant text，持久化并恢复同一个 Codex thread，使用选定的 model 与 reasoning effort，通过 Harness 路由 approvals，在 Harness file confinement 下运行 Codex process，并通过经过认证的 local MCP gateway 向 Codex 暴露明确 allowlist 中的 Harness tools。

## 范围

本设计完成现有原生 `external-session-codex` 路径。范围包括 repository 发布的 macOS、Linux 与 Windows local providers、可单独选择的 Web bundle、keyless real-composition coverage，以及运行完成 bundle 所需的配置。

ACP、Claude Code、远程多用户 hosting、transport reconnect 后对 partial token stream 的无缝恢复、background scheduling、workflows、terminal/jobs，以及不受限导出全部 Harness tools 都不在本变更内。这些排除项不缩小 Codex conversation flow：prompts、model selection、reasoning effort、live text、committed transcript、command/file activity、approvals、interruption、compaction、restart recovery 与 allowlisted MCP calls 仍然全部要求支持。

## 现有基础

`ctx.externalSessions` 已经注册 named providers 并分派 session operations。`external-session-codex` 已经拥有持久化 app-server，并把已提交的 Codex items 映射为仅日志的 `external/*` events。`external-session-bridge` 为新的 external-mode session 启动 provider。`ui-session-mode` 已经渲染 mode picker 与已提交的 external transcript nodes。host 已经接受 `session.create({ mode, model })`，并拥有 external `session.command` route。

未完成的部分都属于承重路径：Web profile 没有挂载 server-side provider family，live deltas 被丢弃，Codex thread id 不持久化，cold sessions 被重新创建而非恢复，选定的 model/policy fields 没有发送到 0.147.0 wire，process 绕过了 `ctx.sandbox`，external prompts 走 native-Agent client paths，而且不存在 Harness-to-MCP server。

## 架构

### Session 创建与 provider 选择

opt-in 的 `web-codex` bundle 叠加在 `base` 与 `web-app` 上。它挂载 `external-session`、`external-permission`、`external-session-codex`、`external-session-bridge` 与 MCP gateway。默认 Web bundle 保持不变，不启动或宣传 Codex。

Codex provider 有结构化 preflight operation。它验证配置的 executable，执行 app-server handshake 与 account/auth status read，但不暴露 credentials，并返回类型化 availability failure。session 创建在发布 Codex-mode session 前再次执行决定性 preflight。binary 缺失、authentication 不可用、不支持的 sandbox mode 或 invalid configuration 会在 stranded session 出现前失败。

provider 依赖维护的 `@openai/codex` runtime package，也可以使用显式配置的 executable。显式配置优先；否则解析 packaged launcher 时不经过 shell interpretation。provider 使用用户已有的 Codex authentication，并使用 Harness 管理的按 session 独立的 `CODEX_HOME`。

### 每 session 状态与 file confinement

`workspace-write` confinement 允许 session workspace 与一个 host-owned private state directory。`SandboxExecutionPolicy` 增加可选的 `stateRoot`；它不从 model input 或 tool call 派生。调用方以 owner-only permissions 创建目录，进行 canonicalization，并且只在 confinement stateful child process 时传入该目录。每个 local sandbox backend 在现有 workspace 与 private-temp permissions 之外，都会授予这一个准确的 state directory。`read-only` 忽略 `stateRoot` 且不授予写入。`danger-full-access` 继续绕过 confinement。

provider 在 configured Harness-owned root 下以 opaque session id 为 key 保存每个 Codex home。它用 `0700` 创建目录，用 `0600` 创建 credential/config files。Codex credentials 不会放进 workspace、command line、logs、session events 或 MCP URL。process 停止后 state directory 保留，以便 cold Harness session 恢复。删除 session 时通过明确的 owner operation 删除它；普通 process disposal 不会删除。

app-server argv 先构建（必要时包含 Windows `cmd.exe` launcher），再通过 `ctx.sandbox.confine` 包装一次。confinement 失败是 fatal；provider 绝不回退到 unconfined spawn。subprocess service 保留 environment scrubbing 与 whole-tree ownership。

### Codex settings 与 policy 映射

`ExternalSessionStart` 携带解析后的 `model`、`reasoningEffort`、Harness sandbox mode 与 approval policy。Codex 在 `thread/start`、`thread/resume` 与 `turn/start` 上收到稳定 fields：

| Harness | Codex |
|---|---|
| model id | `model` |
| reasoning effort | `turn/start.effort` |
| approval `ask` | `approvalPolicy: "on-request"` |
| approval `never` | `approvalPolicy: "never"` |
| `read-only` | `sandbox: "read-only"` / read-only turn policy |
| `workspace-write` | `sandbox: "workspace-write"` / workspace-write turn policy |
| `danger-full-access` | `sandbox: "danger-full-access"` / danger-full-access turn policy |

provider 使用生成的 0.147.0 app-server types 作为 compatibility authority。不再保留 model fields 不存在这一错误假设。runtime model 与 effort changes 使用稳定的 per-turn overrides。未来若使用 `thread/settings/update` 或 named permission profiles，必须显式进行 experimental capability negotiation；本变更不需要它们。

改变 live external session 的 Harness sandbox mode 会在新的 outer policy 下重启 app-server，等待旧 process tree quiescence，然后恢复同一个 Codex thread。只更新 inner Codex sandbox 不够。

### Durable thread identity 与 cold resume

`external/session-started` 在 `thread/start` 成功后记录 provider thread id。id 是 opaque provider state，绝不从 paths 推断。external transcript projection 暴露 host attachment 所需的最新状态，但不让它进入 model-visible surface。

external-session service 区分 `start` 与 `resume`。resume 需要 durable provider thread id；失败时绝不创建新 thread。host 通过 `SessionPersistence.prepare` 恢复 cold session，进入并 announce prepared session，然后要求 provider resume。attachment failure 回滚 live route，并保持 durable session 可读。

cold attachment 按需发生。listing 或读取 history 不会为每个 persisted session 启动 process。第一次 prompt、compact、可 interrupt 的 operation 或 settings change 才会 attachment provider。

如果 child 在 turn 中死亡，provider 将 active turn 结算为 failed，关闭旧 listeners，等待 process tree，之后才允许新的 app-server 加 `thread/resume`。任何 prompt 都不得无限等待死 process 所拥有的 `activeEnd` promise。

### Live transcript transport

`ExternalBridgeContext.streamDelta` 发出类型化 host event。host 将它投影为按 session 与 turn 标识的新 `MuxFrame` variant。frame 只在 live 期间存在，不会成为 synthetic session event。

client session 按 external turn 累积 delta text，并通过 frame notifier 合并 visual updates。durable committed `external/message-added` 会替代并清除 accumulator。disconnect、reconnect、subscription replacement、session close 与 turn failure 都清除 partial live state。reconnect 会回填 committed history，但不会声称能够恢复丢失的 partial token stream。

conversation view 由 `ui-session-mode` 提供一个 external-live seat。它使用与 committed external agent text 相同的 Markdown presentation；没有 partial text 时不显示。

### External tool execution identity

MCP gateway 必须调用 `ctx.tools.execute`；直接调用 definition 会绕过 guards、approvals、events、result validation 与 rendering。伪造未注册的 `Agent` 同样无效，因为多个 consumers 假设存在 registered native-agent lifecycle 与 open native turn。

因此 tool runtime 只接受一种 execution identity：native `agent` 或 `ExternalToolPrincipal`。external principal 携带 opaque id、session、scoped Cordis context 与 recorder，用于持久化 external tool call/result events。共享 helper 从两种 identity 派生 execution scope 与 session。registration lookup、restrictions、guards、cancellation、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、output validation 与 `tools/result` 仍是同一个 pipeline。

external approval 在 approval service 上拥有显式 operation。它使用同一 configured policy 与 fail-closed human decision channel，但记录 external approval bracket，而不是伪造 native `turn/start`/`turn/end`。dismissal、timeout、missing answerer、principal disposal 与 gateway cancellation 都会拒绝 action。

初始 MCP allowlist 排除要求 native Agent 或 native turn 的 tools：ask-user、schedule、workflow、Cordis self-modification、terminal、jobs 与 subagent orchestration。shell 与 filesystem tools 只有在其 execution helpers 从共享 execution identity 派生信息后才 eligible。unknown 与 unlisted tools 在 dispatch 前失败。

### MCP gateway

`mcp-gateway` 是完整 capability，包含 Service Definition、loopback HTTP provider 与 external-session Codex consumer。创建 gateway instance 返回 authenticated endpoint 与 async disposer。每个 instance 拥有 random route id 与 bearer token、session-bound external principal、fixed allowlist、request-size 与 execution-time bounds，以及 abort signal。

server 只绑定 loopback。authentication 与 route lookup 早于 JSON parsing 与 dispatch。公开 URL 只包含 opaque random route，不含 raw session id。`tools/list` 只返回 principal scope 可见的 allowlisted definitions。`tools/call` 验证 tool name 与 input，调用 `ctx.tools.execute`，并把结果映射为 MCP text/structured content 与 `isError`，不转发不受信任的 headers 或 ambient environment。

provider 通过明确的 credential-shaped environment variable 把 endpoint 写入每 session 的 Codex config，并提供 bearer token。MCP token 不持久化，session attachment 时重新生成。resume 只重写 ephemeral endpoint/token config，同时保留 Codex rollout files。gateway disposal 先于 child termination，使 late calls fail closed。

### Client routing

session summaries 与 client session state 保留 durable mode。native session 继续使用 native prompt/command remotes。Codex session 将普通 text 与 pass-through slash lines 发送到 `api.sessions.command`；`/compact` 与 `/model` 保持专用 external command behavior。images、queue/steer 与 native goals 在拥有 external provider operations 前显示明确的 unavailable 状态；绝不静默路由到不存在的 native Agent。

Web settled barrier 识别 external session 的 `external/turn-ended`。native `turn/end` 行为保持不变。

## 错误与生命周期

所有 provider start/resume failures 都以类型化方式在 session UI 可见。任何 failure 都不会创建 replacement Codex thread、静默移除 confinement、改变 tool allowlist 或接受 approval。process disposal 关闭 event/request listeners，abort pending approvals 与 MCP calls，interrupt active turn，terminate process tree，并等待 `done`。

unexpected callbacks 会被 containment 并记录，不会饿死 sibling listeners。external delta frames 可能因 client session 尚未 materialize 而被丢弃，因为 committed log 仍是权威来源。只有 operation 到达 commit point 后才追加 durable events。

## 验证

每个 behavior change 都遵循 red-green TDD。package tests 覆盖 wire payloads、model/effort/policy mapping、POSIX 与 Windows 上的精确 confined argv、environment scrubbing、process-death settlement、thread-id durability、没有 fallback 的 explicit resume、live delta reset/commit behavior、external principal restrictions/guards/approval、MCP authentication/allowlist/bounds/result mapping 与 provider preflight。

真实 Loader composition test 启动 base + Web + opt-in Codex bundle。keyless app-server fixture 证明 provider 被列出，Codex-mode session 没有 native Agent，Web prompt 到达同一个 persistent Codex thread，live 与 committed text 都渲染，allowlisted MCP call 通过 `ctx.tools.execute`，denied tool fail closed，restart attachment 使用 `thread/resume` 而不是 `thread/start`。

Web accessibility snapshot 覆盖 mode picker、live response、committed transcript、command/file activity 与 approval prompt。default Web composition tests 证明 Codex 仍是 opt-in。完成前运行相关 typecheck、lint、build、hygiene、doc-sync、built profile smoke 与 snapshot replay；除非 cross-cutting failure 要求本地诊断，否则 full suite 由 CI 负责。

## 文档

现有 implemented Agent Note 只记录已经发布的行为与验证。过时的 proposed note 只保留尚未实现的后续阶段，或缩小为更准确的 proposed note；不得让它继续作为已完成 Phase 1 的 current authority。每个变更的 package 都要通过所属 source 与 repository generators 更新 README、JSDoc、known limitations、English/Chinese pair 与 generated catalogs。

## 已考虑的替代方案

**PTY embedding。** 拒绝，因为 terminal pixels 不提供 structured approvals、durable transcript units、model settings、tool events 或 policy enforcement。

**Codex path 使用 `codex-acp`。** 本变更拒绝，因为 native provider 已存在，额外 translation layer 会削弱 thread resume 与 provider-specific settings。未来 generic ACP provider 可以使用它。

**Synthetic native Agent。** 拒绝，因为这会创建一个部分注册的 identity，没有 native loop 或 turn；依赖 agent registry、inbox 或 native approval bracket 的 tools 会产生不一致失败。

**只使用 inner Codex sandbox。** 拒绝，因为 app-server process 与 native tools 仍在 Harness confinement 之外。

**将全局 `CODEX_HOME` 放进 workspace-write。** 拒绝，因为这要么无法持久化，要么要求 child 获得整个用户 Codex home 的写权限。单个 host-owned state root 是更窄的 permission。

**Startup resume sweep。** 拒绝，因为读取 session list 会为每个历史 Codex session 启动一个 process。按需 attachment 保持 history reads 廉价并明确 process ownership。
