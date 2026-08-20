# Codex app-server 0.147.0——证据记录

[English](README.md) | 中文

这些 JSON-RPC 记录来自 `@openai/codex@0.147.0` 的真实 `codex app-server --stdio` wire，并通过进程内 OpenAI Responses SSE fixture 捕获；后续 Codex 任务据此实现方法名与通知路由。

## 环境

- **Codex 版本：** `codex-cli 0.147.0`（原生二进制，不是 npm 启动器）。
- **原生二进制解析：** `record-spike.mjs` 优先使用 `argv[2]` 的路径，否则解析 `@openai/codex@0.147.0` 平台包中的原生二进制。
- **种子配置：** `$CODEX_HOME/config.toml` 使用 fixture provider、`approval_policy = "on-request"`、`sandbox_mode = "read-only"`、`disable_response_storage = false`。
- **Fixture：** 与 `packages/subagent/subagent-codex/tests/responses-fixture.ts` 相同的 Responses SSE 事件序列，覆盖完整文本轮次与函数调用轮次。
- **帧格式：** 子进程 stdio 上的换行分隔 JSON-RPC；多轮复用 `thread/start { ephemeral: false }`，线程持久化到 `$CODEX_HOME/sessions/` 下的 rollout `.jsonl`。

## 记录方式

每个文件由同目录的 `record-spike.mjs` 运行生成，记录客户端请求/通知、服务端响应、服务端请求、服务端通知及裁剪后的 fixture 请求体；UUID、绝对路径与时间戳会替换为稳定的 `<volatile:...>` 标记。

| 记录 | 场景 | 证明 |
| --- | --- | --- |
| `thread-persistence.json` | `thread/start{ephemeral:false}`、同线程两次 `turn/start`、进程关闭、全新进程 `thread/resume{threadId}` | 非临时线程、同线程多轮、冷重挂 |
| `turn-notifications.json` | 一个完整轮次与一个通过 `turn/interrupt` 中断的轮次 | 通知族与中断终态 |
| `approvals.json` | `approval_policy = "on-request"` 下的工具调用，分别回答 `accept` 与 `decline` | 审批请求、决策、工具结果往返 |
| `models.json` | `model/list` | 原生模型目录 |
| `compact.json` | 一轮后调用 `thread/compact/start` | 专用压缩方法 |

## 方法判断

`stable` 表示由 0.147.0 生成的协议 schema 确认，`observed` 表示也在真实记录中出现。不要把未确认的实验性 API 加入此 wire。

- **stable**——由此版本的生成协议确认。
- **observed**——在真实记录文件中出现。

### 客户端 → 服务端请求

| 方法 | 判断 | 说明 |
| --- | --- | --- |
| `initialize` | stable, observed | 握手；响应携带 `userAgent`、`codexHome`、平台信息。 |
| `thread/start` | stable, observed | `{ cwd, ephemeral, model?, sandbox?, approvalPolicy? }`；`ephemeral:false` 持久化 rollout。 |
| `turn/start` | stable, observed | `{ threadId, input, model?, effort?, sandbox?, approvalPolicy? }`；响应 `{ turn }` 后发送 `turn/started`。 |
| `turn/interrupt` | stable, observed | `{ threadId, turnId }`；以 `interrupted` 的 `turn/completed` 结算。 |
| `thread/resume` | stable, observed | `{ threadId, model?, sandbox?, approvalPolicy? }`；冷进程返回线程与初始轮次页。 |
| `model/list` | stable, observed | 原生模型目录，返回 `{ data, nextCursor }`。 |
| `thread/compact/start` | stable, observed | 专用压缩路径，立即返回 `{}`，压缩作为后台轮次运行。 |
| `initialized` | stable, observed | `initialize` 后发送一次客户端通知。 |

### 服务端 → 客户端请求

| 方法 | 判断 | 说明 |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | stable, observed | 参数含线程、轮次、工具项、原因、命令与 `availableDecisions`；回答 `{ decision }`。 |
| `accept` | stable, observed | 允许分支，命令实际执行。 |
| `decline` | stable, observed | 拒绝分支，轮次继续并完成。 |
| `cancel` | stable, generated | 生成协议与审批请求的可选决策；小型记录未重新回答。 |

### 服务端通知

| 方法 | 判断 | 说明 |
| --- | --- | --- |
| `thread/started` | stable, observed | 完整 `thread` 对象，在 `thread/start` 或 `thread/resume` 后发送。 |
| `turn/started` | stable, observed | `{ threadId, turn }`。 |
| `item/started` | stable, observed | `{ item, threadId, turnId, startedAtMs }`；item 类型包括 `userMessage`、`agentMessage`、`commandExecution`。 |
| `item/agentMessage/delta` | stable, observed | 流式助手文本：`{ threadId, turnId, itemId, delta }`。 |
| `item/completed` | stable, observed | 已提交 item：`{ item, threadId, turnId, completedAtMs }`。 |
| `turn/completed` | stable, observed | 终态：`{ threadId, turn: { id, items, status, ... } }`；`status` 为 `completed`、`interrupted` 或 `failed`。 |
| `thread/status/changed` | stable, observed | 生命周期包括 `active`、`idle` 与 `activeFlags: ["waitingOnApproval"]`。 |
| `thread/tokenUsage/updated` | stable, observed | `{ threadId, turnId, tokenUsage }`。 |
| `serverRequest/resolved` | stable, observed | 客户端回答服务端请求后发送 `{ threadId, requestId }`。 |
| `warning` | stable, observed | fixture 模型缺少元数据时出现的预期通知。 |
| `account/rateLimits/updated`、`remoteControl/status/changed` | stable, observed | 环境生命周期通知。 |
| `thread/compacted` | stable, generated | 由生成协议确认；小型压缩窗口未观察到。 |

## 后续实现结论

- **模型目录原生存在：** 不需要回退名册；记录的模型包括 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5` 与 `gpt-5.2`。
- **稳定设置是请求字段：** `thread/start` 与 `thread/resume` 接受模型及 sandbox/approval 覆盖；`turn/start` 接受模型、`effort`、sandbox 与 approval 覆盖。Harness 的 `ask` 映射为 `on-request`，`never` 映射为 `never`，reasoning effort 映射为 `effort`。
- **压缩是专用方法：** `thread/compact/start` 是异步后台轮次，不是 slash passthrough。
- **线程支持冷恢复：** `ephemeral:false` 与 `thread/resume` 可跨进程重启恢复持久线程。
- **审批决策可直接映射：** allow → `accept`、reject → `decline`，并提供 `cancel`。
