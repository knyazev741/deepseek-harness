# @deepseek-ai/dsh-external-session-codex

[English](README.md) | 中文

持久化 Codex 外部 agent 会话提供方。在 [`ctx.externalSessions`](../external-session/README.md) 上注册 `codex` mode：每个被接受的会话都启动官方 `codex app-server --stdio` 命令，在会话工作目录中打开一条非临时（non-ephemeral）线程，然后在该线程上服务重复的 prompt。实时助手文本通过逐会话 bridge 的 `streamDelta` 流出；已提交的消息、工具活动、审批询问与终态停止原因被记录为仅日志的 `external/*` 会话事件；压缩通过专用的 `thread/compact/start` 方法进行；而 app-server 意外退出则会通过重启进程并 `thread/resume` 那条持久线程来恢复。一次性兄弟包 [`@deepseek-ai/dsh-subagent-codex`](../../subagent/subagent-codex/README.md) 驱动自己的临时线程；本提供方则是与之对应的交互式、持续性版本。

## 启动与所有权

`start(request)` 通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 在会话工作目录下启动 app-server，执行 `initialize` → `initialized` → `thread/start { cwd, ephemeral: false }`，并在会话生命周期内保留该非临时线程 id。一旦线程存在，提供方就发出 `external/session-started`。

`prompt(text)` 严格串行地轮转：它等待上一条轮次的 `turn/completed` 终态通知，在同一条线程上提交下一条 `turn/start`，并立即返回提供方签发的轮次 id。该轮次随后异步流式运行至完成：`item/agentMessage/delta` 被转发到 `streamDelta`（仅实时，绝不持久化）；一条完成的 `agentMessage` 被提交为 `external/message-added { role: 'agent' }`，提交的 prompt 被提交为 `{ role: 'user' }`，`commandExecution` 项被提交为 `external/tool-activity { kind: 'call' | 'result' }`，终态的 `turn/completed` 被提交为 `external/turn-ended`（`completed` / `aborted` / `error` / `max-tokens`）。`interrupt()` 发送尽力而为的 `turn/interrupt`，其中断后的终态映射为 `aborted`。

审批询问以 `item/commandExecution/requestApproval` 形式抵达。提供方发出 `external/permission-asked`，咨询 bridge 的 `requestPermission`（ask-user 权限通道），把人类的 `allowed` / `rejected` / `cancelled` 决策映射到线上的 `accept` / `decline` / `cancel`，回答该请求，并记录 `external/permission-decided`。失败、未接线或关闭的权限通道会故障关闭到最安全的已提供决策与 `cancelled`。

`compact()` 调用专用的 `thread/compact/start` 并记录 `external/compaction-noticed`；压缩随后作为后台轮次沿常规通知路径运行。

当 app-server 进程在会话中途退出时，下一次操作会启动一个新的子进程，并用 `thread/resume` 重新挂接持久线程（冷重挂；见证据 `thread-persistence.json`）。`dispose()` 记录 `external/session-ended`、中断任何活动轮次、关闭 wire，并运行整棵进程树的终止阶梯（stdin EOF 宽限期，然后是共享进程树的 SIGTERM → 宽限 → SIGKILL 升级）。

## 模型列出与切换

证据确认 0.147.0 原生存在 `model/list`（`models.json`），因此提供方从实时 wire 的原生目录回答 `listModels`，并声明 `modelDirectory: 'provider'`；不使用回退名册配置。当没有活跃会话时，`listModels` 会在部署工作目录下运行一条短命 wire（目录是本地的，因此工作区无关紧要）。

`setModel` **响铃式拒绝**：0.147.0 app-server 在实时线程上不暴露任何运行时模型切换，也没有按轮次模型选项——证据中没有列出 `thread/model` 方法，且 `thread/start` / `turn/start` / `thread/resume` 都不接受 `model` 字段。请改在 Codex 配置中选择模型；原生列表保持只读。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `command` | `codex` | app-server 命令或路径，从 `PATH` 解析；绝不做 shell 解释（在 Windows 上用 `cmd.exe /d /s /c` 包裹）。 |
| `args` | `["app-server", "--stdio"]` | app-server 参数；空字符串会使加载失败。 |
| `env` | `{}` | 显式子进程环境，叠加在 subprocess seam 已清洗凭证的父环境之上。 |
| `disposeGraceMs` | `3000` | 正有限毫秒宽限，不大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)，介于共享进程树所有者的各终止层级之间。 |

生产环境从 `PATH` 解析 `codex`，并使用宿主原生的 Codex 配置与认证。本插件不安装 Codex、不登录、也不探测版本。subprocess seam 会移除凭证形状的环境变量，因此为子进程准备的 API 密钥必须显式提供在 `env` 中；普通的 `PATH`、`HOME` 等环境值在未覆盖时保持可用。

生产环境的 `dsh` 不安装也不挂载这个可选提供方。选择加入的 Profile 需安装 `@deepseek-ai/dsh-external-session-codex` 与 `dsh-external-session` 注册表，并在宿主平面各挂载一次：

```yaml
- id: external-session
  name: '@deepseek-ai/dsh-external-session'

- id: external-session-codex
  name: '@deepseek-ai/dsh-external-session-codex'
  config:
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY
```

## 产品兼容性与证据

生产 wire 只实现这个持久化约定所需的 app-server 方法；方法名均引用 [0.147.0 证据记录](tests/evidence/README.md)。共享的新行 JSON-RPC 传输来自 `@deepseek-ai/dsh-sdk-protocol`；一次性兄弟包不导出其 wire，且其单临时线程、无人值守审批的数据流不适合交互式会话，因此传输层是复用边界，产品方法则位于此处。开发证据固定为 `@openai/codex@0.147.0` / `codex-cli 0.147.0`；npm 包仅是测试依赖，部署仍需在 `PATH` 上提供 `codex`。

## 模型体验

### 外部 agent 活动，仅日志

#### 模型看到什么

在 DSH 父会话中什么都看不到。外部 agent 的对话记录、工具活动、审批结果与压缩通知被记录为仅日志的 `external/*` 会话事件（`ignorable: true`），供回放投影使用；其中没有任何内容被织入父会话的请求上下文、提示词或工具 schema。Codex 子进程本身在其非临时线程中看到提交的 prompt 以及自己流式输出的对话记录。

#### Token 影响

对任何 DSH 会话都没有直接的 token 影响：这些仅日志事件不增加请求 token。Codex 子进程为自己的独立 Codex 上下文与轮次付费；子进程 token 不会进入任何 DSH 父上下文。

#### KV 缓存影响

对 DSH 会话缓存无影响：这些事件在任意模型请求之外追加，且与任何请求前缀都不共享，因此本包记录的内容不会令 KV 缓存失效或被重塑。Codex 自身的提供方与持久线程请求独立决定其缓存复用。

## 已知限制与推迟的工作

- **实时线程上无运行时模型切换**——0.147.0（存在 `model/list`；没有 `thread/model` 或按轮次模型选项）使 `setModel` 响铃式拒绝，原生目录保持只读；任务 6 的 `/model` 会呈现此限制。选择 Codex 模型属于配置变更，而非会话切换。
- **无流式持久性保证**——实时增量只沿实时 frame 路径上的 `streamDelta` 传输，绝不写入持久日志；回放仅重建已提交的 `external/*` 单元。
- **审批依赖权限通道**——在宿主插件接线 ask-user 通道之前，`requestPermission` 会故障关闭（`PERMISSION_UNWIRED`）；随后提供方映射到安全的 decline 与 `cancelled`。
- **会话中途 app-server 关闭会被恢复，而非预防**——意外的子进程死亡会在下一次操作时以重启 + `thread/resume` 掩盖；被死亡打断的活动轮次不会发出终态 `turn/completed`（下一轮次的停止状态反映的是已恢复的线程）。
- **压缩通知文本是固定摘要，而非线上压缩详情**——0.147.0 证据显示 `thread/compact/start` 立即返回 `{}`，压缩作为后台轮次运行；持久通知由提供方撰写。
- **兼容性由开发证据固定**——从已验证的 0.147.0 协议基线升级，需要重新生成上游 schema 证据并重跑无密钥的真实产品测试。
