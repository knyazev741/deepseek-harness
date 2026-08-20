# @deepseek-ai/dsh-mcp-gateway

[English](README.md) | 中文

经过认证的回环 Streamable HTTP 网关，为 Codex 等一个外部会话暴露固定且显式允许列表中的 Harness 工具。

## 用法

将网关与本地 Web 服务器和工具运行时一起挂载：

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 0
- name: '@deepseek-ai/dsh-mcp-gateway'
  config:
    allowlist: [read_file, shell_foreground]
```

服务要求 Web 服务器绑定 `127.0.0.1`。外部会话消费者调用 `ctx.mcpGateway.create({ principal, tools, signal })`，得到带有不透明 URL 和内存 bearer token 的 `McpGatewayLease`。

## 安全与策略

认证发生在方法校验、请求体解析、MCP 分发和工具查找之前。每个 lease 都拥有随机路由和 bearer 凭据；路由 URL 与诊断信息都不包含 session id 或 token。配置允许列表会与请求名称以及 Task 5 定义级别的 `externalEligibility: 'allow'` opt-in 求交集，因此省略该字段仍然默认拒绝。

每次调用都以给定的 `ExternalToolPrincipal` 进入 `ctx.tools.execute`。网关不会直接调用定义、创建原生 Agent、打开原生 turn 或使用 scheduler 内部接口，因此普通流水线中的 guard、approval、验证、渲染、结果观察器和外部 recorder 都会继续生效。recorder 在分发前提交一次 call，在分发后提交一次匹配的 result 或 error。

请求只接受有状态 MCP 端点上的 `GET`、`POST` 和 `DELETE`。JSON POST 请求体必须是 `application/json`，严格按 UTF-8 解码，只包含一个无尾随字节的 JSON 值，并遵守配置的字节和时间限制。未知路由、session、方法和工具名称都会故障关闭。

## 配置

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `allowlist` | `[]` | 允许外部暴露的固定工具名称；定义还必须用 `externalEligibility: 'allow'` 显式 opt-in。 |
| `maxRequestBytes` | `65536` | 单个 JSON 请求体的最大 UTF-8 字节数。 |
| `executionTimeoutMs` | `60000` | 读取请求体和协作式工具调用的截止时间；lease 处置会中止同一信号。 |

## 生命周期

lease disposer 会移除路由、中止进行中的调用、等待请求处理器并关闭有状态 MCP transport。外部 Codex provider 会在拆除子进程前等待该 disposer。恢复 attachment 会在私有 Codex home 中写入新的端点和 token，同时保留已有 rollout 文件。

token 只通过 `bearer_token_env_var` 指定的显式环境变量传递给 Codex；它不会写入 `config.toml`、URL、argv、session 事件、日志或快照。本包不配置客户端路由或 Web opt-in bundle；这些属于后续任务。

## 服务

| 服务 | 用途 |
|---|---|
| `ctx.webServer` | 为每个活动 lease 注册一个精确回环路由。 |
| `ctx.tools` | 快照 schema，并通过 external-principal 流水线分发调用。 |
| `ctx.approval` | 可选的显式 external approval 流水线消费者。 |
| `ctx.externalSessions` | 通过 external-session consumer 持有 principal recorder 和 attachment 生命周期。 |

## 模型体验

### 外部工具目录与调用

#### 模型看到什么

Codex 只会看到 `tools/list` 返回的配置允许列表中的工具 schema。成功调用返回 Harness 渲染的文本和对象型 structured content；失败调用返回带 MCP `isError` 的内容。父 Harness 模型不会把外部网关调用当作原生 turn。

#### Token 影响

Codex 在自己的上下文中承担已发布 schema、参数和映射结果内容的 token 成本。bearer 凭据和路由是 transport 凭据，不是模型可见内容。

#### KV 缓存影响

只要固定集合和定义不变，已发布的 schema 前缀即可复用。新的 attachment 只轮换不透明 transport endpoint 和凭据，不增加持久化模型上下文。

## 已知限制与推迟的工作

- 不暴露 resources、prompts、SSE 广播或非回环托管；网关有意保持为单 attachment 的回环工具端点。
- 超时是协作式的：工具实现必须观察执行 signal，并在处置完成前结算其拥有的工作。
- Web opt-in bundle 与客户端 Codex 路由由后续任务负责，不属于本包。
