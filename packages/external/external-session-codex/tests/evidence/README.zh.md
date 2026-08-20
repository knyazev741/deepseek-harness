# Codex app-server 0.147.0 — 证据转录本

[English](README.md) | 中文

真实 **`codex app-server --stdio`** 线路在 `@openai/codex@0.147.0` 上的记录式 JSON-RPC 转录本，通过进程内 OpenAI Responses SSE fixture 捕获。这些是后续所有 Codex 任务据以编码的方法与通知名的真值来源。

## 环境

- **Codex 版本：** `codex-cli 0.147.0`（原生二进制，非 npm 启动器）。复现：`node record-spike.mjs <native-codex-binary>`。
- **`record-spike.mjs` 中原生二进制解析：** 传入 `argv[2]` 的路径优先；否则解析 `packages/subagent/subagent-codex` 的 `@openai/codex@0.147.0` devDependency 下的平台包（提升到工作区 `.pnpm` store，因此在本 checkout 上需显式传入）。在本机上：
  `node_modules/.pnpm/@openai+codex@0.147.0/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`。
- **种子配置**（写入 `$CODEX_HOME/config.toml`，与 `real-product.spec.ts` 共享）：`model = "fixture-model"`、`model_provider = "fixture"`、`approval_policy = "on-request"`、`sandbox_mode = "read-only"`、`disable_response_storage = false`，以及将 `base_url` 指向回环 fixture 的 `[model_providers.fixture]` 块（`wire_api = "responses"`、`requires_openai_auth = false`、`env_key = "OPENAI_API_KEY"`）。环境网络代理被擦除，`NO_PROXY` 固定 `127.0.0.1,localhost`。
- **Fixture：** 与 `packages/subagent/subagent-codex/tests/responses-fixture.ts` 相同的 Responses SSE 事件序列（一次 `complete` 文本轮次与一次 `function_call` 轮次），按每个模型请求提供。
- **组帧：** 子进程 stdio 上的换行分隔 JSON-RPC。若干轮次复用 `thread/start { ephemeral: false }` 使线程持久化到 `$CODEX_HOME/sessions/` 下的 rollout `.jsonl`。

## 每个转录本是怎样产生的

每个文件都由一次 `record-spike.mjs` 运行产生（上文引述的记录器与本转录本同在本目录）：`node record-spike.mjs /path/to/native/codex`。记录器驱动每个场景，捕获每一帧（客户端请求/通知、服务端响应、服务端→客户端请求、服务端通知、以及裁剪后的 fixture 请求），并将 JSON 文件原地写回。易变值（UUID、绝对路径、毫秒时间戳）被替换为 `<volatile:...>` 标记以保持 diff 稳定；fixture 请求体裁剪为模型、各角色输入文本以及所通告的工具名。

| 转录本 | 由谁产生 | 它证明什么 |
| --- | --- | --- |
| `thread-persistence.json` | initialize → `thread/start{ephemeral:false}` → 同一 `threadId` 上的两次 `turn/start` → 进程关闭 → **新进程** 在相同 `CODEX_HOME` 上的 `thread/resume{threadId}` | 非临时线程；同一线程上的第二次轮次；线路重启后的冷重连 |
| `turn-notifications.json` | 一次 `complete` 轮次后接一次被 `turn/interrupt` 中断的 `hold` 轮次 | 一轮内的通知族与中断停止路径 |
| `approvals.json` | 两次轮次，各自在 `approval_policy = "on-request"` 下驱动一次 `shell_command` 工具调用；记录器分别用 `accept` 与 `decline` 应答 `item/commandExecution/requestApproval` | 两条分支上的 工具调用→批准请求→决策→解决 往返 |
| `models.json` | initialize → `model/list` | 原生模型列表面 |
| `compact.json` | 一次轮次，随后 `thread/compact/start{threadId}` | 专用压缩路径 |

## 注释

下面每个方法都标注：

- **`stable`** — 已针对此确切版本生成的协议确认，`codex app-server generate-ts --out <dir>` / `app-server generate-json-schema --out <dir>`（0.147.0 真值来源；也是 codex-rs/docs 派生名所在）。补丁级升级中预计这些名称不变。
- **`observed`** — 出现在这些转录本的真实记录载荷中（健全性门槛：除非名称出现在转录本文件中，否则不标注 `observed`）。

### 客户端 → 服务端请求

| 方法 | 判定 | 说明 |
| --- | --- | --- |
| `initialize` | stable, observed | 握手；响应携带 `userAgent`、`codexHome`、`platformFamily`、`platformOs`。 |
| `thread/start` | stable, observed | `{ cwd, ephemeral }`；`ephemeral:false` 持久化到 rollout `.jsonl`（见 `.result.thread.path` 与 `thread/started`）。 |
| `turn/start` | stable, observed | `{ threadId, input: [{ type: "text", text, text_elements: [] }] }`；响应 `{ turn }`，随后 `turn/started`。 |
| `turn/interrupt` | stable, observed | `{ threadId, turnId }`；响应 `{}`；以 `turn/completed` 状态 `interrupted` 结束该轮次。 |
| `thread/resume` | stable, observed | `{ threadId }` 恢复持久线程；在冷重启进程中返回 `thread` 外加 `initialTurnsPage`、`turnsBackwardsCursor`、`itemsBackwardsCursor`。 |
| `model/list` | stable, observed | 原生模型花名册；返回 `{ data: [...], nextCursor }`。在 0.147.0 中**并非 ABSENT**。 |
| `thread/compact/start` | stable, observed | **就是**压缩路径。**并非 ABSENT**：专用方法（而非 `/compact` 斜杠透传）。立即响应 `{}`；压缩作为后台轮次运行（`turn/started`、`item/started`、额外模型轮次、`turn/completed`）。 |
| `initialized`（客户端通知） | stable, observed | 在 `initialize` 之后发送一次。 |

### 服务端 → 客户端请求

| 方法 | 判定 | 说明 |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | stable, observed | 工具升级；参数携带 `threadId`、`turnId`、`itemId`、`startedAtMs`、`environmentId`、`reason`、`command`、`commandActions`、`proposedExecpolicyAmendment`、`availableDecisions`。应答 `{ decision }`。 |
| 决策值 `accept` | stable, observed | 允许分支（转录本 `approvals.json`）；命令实际执行（`true`）。 |
| 决策值 `decline` | stable, observed | 拒绝分支；轮次继续并完成。 |
| 决策值 `cancel`（及 `acceptWithExecpolicyAmendment`） | stable, generated | 在记录到的批准请求的 `availableDecisions` 中提供；本 spike 未再次应答。 |

`item/permissions/requestApproval`、`item/tool/requestUserInput` 与 `mcpServer/elicitation/request` 出现在生成的协议中但在这些转录本中**未被观测**（脚本中无非沙箱写入或 MCP 工具）；subagent-codex 的 `wire.ts` 已应答它们，是它们形状的参照。

### 服务端通知

| 方法 | 判定 | 说明 |
| --- | --- | --- |
| `thread/started` | stable, observed | 完整 `thread` 对象，在 `thread/start`/`thread/resume` 之后发出。 |
| `turn/started` | stable, observed | `{ threadId, turn }`。 |
| `item/started` | stable, observed | `{ item, threadId, turnId, startedAtMs }`；item `type` 含 `userMessage`、`agentMessage`、`commandExecution`。 |
| `item/agentMessage/delta` | stable, observed | 流式助手文本：`{ threadId, turnId, itemId, delta }`。 |
| `item/completed` | stable, observed | 已提交 item，`{ item, threadId, turnId, completedAtMs }`。 |
| `turn/completed` | stable, observed | 终结：`{ threadId, turn: { id, items, status, ... } }`；`status` ∈ `completed`/`interrupted`/`failed`。 |
| `thread/status/changed` | stable, observed | 生命周期，含 `active`/`idle` 与 `activeFlags: ["waitingOnApproval"]`。 |
| `thread/tokenUsage/updated` | stable, observed | `{ threadId, turnId, tokenUsage }`。 |
| `serverRequest/resolved` | stable, observed | `{ threadId, requestId }`，在客户端应答服务端请求之后发出。 |
| `warning` | stable, observed | 例如 "Model metadata for `fixture-model` not found" —— 使用 fixture 模型时的预期行为。 |
| `account/rateLimits/updated`、`remoteControl/status/changed` | stable, observed | 环境生命周期通知。 |
| `thread/compacted` | stable, generated | 在生成的协议中；在较小的压缩 fixture 窗口内未被观测（压缩仅通过 `turn/completed` 完成）。 |

## 对后续任务的结论

- **原生存在模型清单**（`model/list`）：无需回退花名册。本构建记录到的花名册：`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.2`（fixture 提供的模型不在其中，因此有 `warning` 通知）。
- **压缩是专用方法**（`thread/compact/start`，异步，返回 `{}`），而非 `/compact` 斜杠透传。app-server 线路上没有斜杠命令命名空间。
- **线程持久化并可冷恢复**：`ephemeral:false` + `thread/resume` 跨进程重启有效，因此持久会话提供者可以重连而无需以 `error` 结束。
- **批准决策干净映射**：允许 → `accept`，拒绝 → `decline`，外加 `cancel`。线路暴露 `availableDecisions` 供选择。
