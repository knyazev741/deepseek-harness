# @deepseek-ai/dsh-external-session-codex

[English](README.md) | 中文

持久化 Codex 外部 agent 会话提供方。在 [`ctx.externalSessions`](../external-session/README.md) 上注册 `codex` mode：每个被接受的会话都会启动打包的 `@openai/codex@0.147.0` app-server，除非显式配置命令覆盖；它在会话工作目录中打开一条非临时（non-ephemeral）线程，然后在该线程上服务重复的 prompt。实时助手文本通过逐会话 bridge 的 `streamDelta` 流出；已提交的消息、工具活动、审批询问与终态停止原因被记录为仅日志的 `external/*` 会话事件；压缩通过专用的 `thread/compact/start` 方法进行；而 app-server 意外退出则会先结算活动轮次、回收旧子进程树，再由同一提供方实例用内存中的线程 id 重启子进程并继续。冷的 Harness 会话通过显式 `resume` 与 `thread/resume` 恢复其不透明的持久提供方线程 id；恢复失败绝不创建替代线程。一次性兄弟包 [`@deepseek-ai/dsh-subagent-codex`](../../subagent/subagent-codex/README.md) 驱动自己的临时线程；本提供方则是与之对应的交互式、持续性版本。

## 启动与所有权

`start(request)` 会在首次异步状态根目录操作前发布可取消的提供方生命周期记录，解析会话的 sandbox 与 approval fold，创建私有 Codex 状态目录，然后通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 在会话工作目录下启动 app-server。dispose 会取消该记录并等待启动回滚后才返回，因此路由 dispose 后不会再启动子进程。它执行 `initialize` → `initialized` → `thread/start { cwd, ephemeral: false, model?, sandbox, approvalPolicy }`，并在该提供方实例生命周期内保留非临时线程 id。一旦线程存在，提供方就发出 `external/session-started`。

`resume(request, providerThreadId)` 发布同样的生命周期，但执行 `initialize` → `initialized` → `thread/resume { threadId, model?, sandbox, approvalPolicy }`。它要求持久化的品牌化不透明 id，不会发出新的 `external/session-started`；id 缺失或未知时会拒绝，并且不会回退到 `thread/start`。宿主只在实时操作需要提供方时，才通过 `SessionPersistence.prepare`、`SessionStore.enter` 与 `SessionStore.announce` 物化冷会话。

当可选的 [`dsh-mcp-gateway`](../../mcp/mcp-gateway/README.md) 服务已挂载、bridge 提供 external principal 且 `mcpTools` 非空时，每次 start 或 resume 都会在子进程启动前创建新的认证回环 MCP lease。提供方只把不透明 URL 和 `bearer_token_env_var` 写入私有 Codex `config.toml`；token 通过该显式环境变量注入。lease 处置会在子进程拆除前完成等待；resume 会重写 endpoint/token 段，同时保留同一个哈希 `CODEX_HOME` rollout 状态。

`prompt(text)` 严格串行地轮转：它等待上一条轮次的 `turn/completed` 终态通知，在同一条线程上提交下一条 `turn/start`，并立即返回提供方签发的轮次 id。该轮次随后异步流式运行至完成：`item/agentMessage/delta` 被转发到 `streamDelta`（仅实时，绝不持久化）；一条完成的 `agentMessage` 被提交为 `external/message-added { role: 'agent' }`，提交的 prompt 被提交为 `{ role: 'user' }`，`commandExecution` 项被提交为 `external/tool-activity { kind: 'call' | 'result' }`，终态的 `turn/completed` 被提交为 `external/turn-ended`（`completed` / `aborted` / `error` / `max-tokens`）。`interrupt()` 发送尽力而为的 `turn/interrupt`，其中断后的终态映射为 `aborted`。

审批询问以 `item/commandExecution/requestApproval` 形式抵达。提供方发出 `external/permission-asked`，咨询 bridge 的 `requestPermission`（ask-user 权限通道），把人类的 `allowed` / `rejected` / `cancelled` 决策映射到线上的 `accept` / `decline` / `cancel`，回答该请求，并记录 `external/permission-decided`。失败、未接线或关闭的权限通道会故障关闭到最安全的已提供决策与 `cancelled`。

`compact()` 调用专用的 `thread/compact/start` 并记录 `external/compaction-noticed`；压缩随后作为后台轮次沿常规通知路径运行。

当 app-server 子进程在会话中途退出时，提供方会把活动轮次记录为 `error`，关闭 listener，等待旧子进程树结算；下一次操作在同一提供方实例中启动新的子进程，并用内存中的线程 id 通过 `thread/resume` 继续（同一进程内的子进程重启；协议证据为 `thread-persistence.json`）。同一显式恢复路径也会在 Harness 重启后接受持久化 id。`dispose()` 会为已挂接的实时会话记录 `external/session-ended`，取消尚未完成的审批且不产生迟到决策，中断任何活动轮次、关闭 wire，并运行整棵进程树的终止阶梯（stdin EOF 宽限期，然后是共享进程树的 SIGTERM → 宽限 → SIGKILL 升级）；清理失败会保留在 quiescence 屏障上并阻止重启。

## 模型列出与切换

证据确认 0.147.0 原生存在 `model/list`（`models.json`），因此提供方从实时 wire 的原生目录回答 `listModels`，并声明 `modelDirectory: 'provider'`；不使用回退名册配置。当没有活跃会话时，`listModels` 会在部署工作目录下运行一条短命 wire（目录是本地的，因此工作区无关紧要）。

`setModel` 必要时刷新原生 `model/list` 目录，拒绝未列出的标识符，然后为下一轮保存已接受的模型与可选 reasoning effort，记录 `external/model-switched`，并通过稳定的下一次 `turn/start` 发送 `model`（reasoning effort 使用 `effort`）。初始设置也会发送到 `thread/start` 与 `thread/resume`；不使用实验性 app-server API。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `command` | 打包的 `@openai/codex` | 可选的 app-server 命令或路径覆盖；默认直接解析打包启动器且绝不做 shell 解释（显式 Windows 覆盖使用 `cmd.exe /d /s /c`）。 |
| `args` | `["app-server", "--stdio"]` | app-server 参数；空字符串会使加载失败。 |
| `env` | `{}` | 显式子进程环境，叠加在 subprocess seam 已清洗凭证的父环境之上。 |
| `stateRoot` | Harness 管理的临时根目录 | 每个会话在此根下获得一个私有哈希 Codex 状态目录，并作为子进程的 `CODEX_HOME`。 |
| `reasoningEffort` | 未设置 | 可选的初始稳定 reasoning effort；逐会话选择可在下一轮替换它。 |
| `sandbox` / `approvalPolicy` | `read-only` / `ask` | 从会话启动请求与会话 policy fold 解析；Codex 接收 `read-only` / `workspace-write` / `danger-full-access` 以及 `on-request` / `never`。 |
| `disposeGraceMs` | `3000` | 正有限毫秒宽限，不大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)，介于共享进程树所有者的各终止层级之间。 |
| `preflightTimeoutMs` | `30000` | app-server 可用性预检的正有限毫秒截止时间，不大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)。截止后会中止 wire、回收子进程树、删除私有 probe 状态，并以有界消息返回 `PREFLIGHT_FAILED`。 |
| `mcpTools` | `[]` | 传给可选 MCP 网关的 Harness 工具名称；网关会与固定 allowlist 以及定义级别的 external opt-in 求交集。 |
| `allowedTools` | 未设置 | 面向 Profile 的 `mcpTools` 别名；存在时替代旧键，并继续与网关 allowlist 以及定义级别的 external opt-in 求交集。 |

生产环境默认使用固定版本的打包启动器，除非显式配置 `command` 覆盖。本插件不登录，也不探测版本。subprocess seam 会移除凭证形状的环境变量，因此为子进程准备的 API 密钥必须显式提供在 `env` 中；普通的 `PATH`、`HOME` 等环境值在未覆盖时保持可用。受限模式会把准确的启动器 argv 与 `{ ...sandboxPolicy, stateRoot }` 交给 `ctx.sandbox.confine`；`read-only` 下沙盒不会从 `stateRoot` 授予任何可写根目录；缺失 confinement provider 时故障关闭。会话创建前的 model 目录使用明确的 `read-only` policy 与同一私有状态根目录处理，绝不会使用裸的 `danger-full-access` 预检。

MCP bearer 不会放入 Codex URL、TOML、argv、session 事件、日志或快照。网关与子进程属于同一个 attachment 生命周期：网关处置会中止迟到的工具调用，并在释放 app-server 进程树之前完成。

生产环境的 `dsh` 不安装也不挂载这个可选提供方。选择加入的 Profile 需安装 `@deepseek-ai/dsh-external-session-codex` 与 `dsh-external-session` 注册表，并在宿主平面各挂载一次：

```yaml
- id: external-session
  name: '@deepseek-ai/dsh-external-session'

- id: external-session-codex
  name: '@deepseek-ai/dsh-external-session-codex'
  config:
    command: !!js process.env.DSH_CODEX_COMMAND
    stateRoot: !!js dshHomePath('external-codex')
    allowedTools: []
```

提供方会在该行被公告或 session 被发布前执行 preflight。如果本地部署无法启动它，mode 会报告 `BINARY_MISSING`、`AUTH_UNAVAILABLE`、`INVALID_CONFIG`、`SANDBOX_INCOMPATIBLE` 或有界的 `PREFLIGHT_FAILED`；截止时间可通过 `preflightTimeoutMs` 配置，超时后不会留下 probe 子进程或状态目录。Codex 账户仍由用户自行登录，该 profile patch 永远不会保存账户信息。

## 产品兼容性与证据

生产 wire 只实现这个持久化约定所需的 app-server 方法；方法名与稳定请求字段均引用 [0.147.0 证据记录](tests/evidence/README.md)。共享的新行 JSON-RPC 传输来自 `@deepseek-ai/dsh-sdk-protocol`；一次性兄弟包不导出其 wire，且其单临时线程、无人值守审批的数据流不适合交互式会话，因此传输层是复用边界，产品方法则位于此处。开发与生产默认解析固定的 `@openai/codex@0.147.0` 包，除非显式提供命令覆盖。

## 模型体验

### 外部 agent 活动，仅日志

#### 模型看到什么

在 DSH 父会话中什么都看不到。外部 agent 的对话记录、工具活动、审批结果与压缩通知被记录为仅日志的 `external/*` 会话事件（`ignorable: true`），供回放投影使用；其中没有任何内容被织入父会话的请求上下文、提示词或工具 schema。Codex 子进程本身在其非临时线程中看到提交的 prompt 以及自己流式输出的对话记录。

#### Token 影响

对任何 DSH 会话都没有直接的 token 影响：这些仅日志事件不增加请求 token。Codex 子进程为自己的独立 Codex 上下文与轮次付费；子进程 token 不会进入任何 DSH 父上下文。

#### KV 缓存影响

对 DSH 会话缓存无影响：这些事件在任意模型请求之外追加，且与任何请求前缀都不共享，因此本包记录的内容不会令 KV 缓存失效或被重塑。Codex 自身的提供方与持久线程请求独立决定其缓存复用。

## 已知限制与推迟的工作

- **模型选择从下一轮生效**——`setModel` 记录选定模型与可选 reasoning effort，并通过稳定的 `turn/start` 字段发送；不会改变正在运行的轮次。
- **无流式持久性保证**——实时增量只沿实时 frame 路径上的 `streamDelta` 传输，绝不写入持久日志；回放仅重建已提交的 `external/*` 单元。
- **审批依赖权限通道**——在宿主插件接线 ask-user 通道之前，`requestPermission` 会故障关闭（`PERMISSION_UNWIRED`）；随后提供方映射到安全的 decline 与 `cancelled`。
- **app-server 子进程关闭会先结算再恢复**——意外的子进程死亡会把活动轮次结算为 `error`，随后下一次操作重启并恢复内存中的线程 id；冷宿主会话通过显式 `resume` 使用持久化的提供方线程 id，死亡的 app-server 本身不会再发出终态 `turn/completed`。
- **本地认证仍由部署负责**——无密钥的组装 Web fixture 提供 loopback Responses provider 与本地账户探测；真实部署必须先为配置的 Codex 可执行文件完成认证，preflight 才会公告该 mode。
- **启动失败可能留下空的哈希状态目录**——该目录是私有的并由提供方拥有；进程回滚不会删除它，因为后续显式恢复可能仍需保留的 Codex rollout 状态。
- **压缩通知文本是固定摘要，而非线上压缩详情**——0.147.0 证据显示 `thread/compact/start` 立即返回 `{}`，压缩作为后台轮次运行；持久通知由提供方撰写。
- **兼容性由开发证据固定**——从已验证的 0.147.0 协议基线升级，需要重新生成上游 schema 证据并重跑无密钥的真实产品测试。
