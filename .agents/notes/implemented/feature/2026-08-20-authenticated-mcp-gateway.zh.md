# Agent Note: Authenticated loopback MCP gateway for external Codex

Status: implemented

[English](2026-08-20-authenticated-mcp-gateway.md) | 中文

## Problem

外部 Codex attachment 需要本地 Harness 工具目录，同时不能绕过 external-principal 流水线、创建原生 Agent，或把 bearer 凭据放入持久化及模型可见数据。

## Decision

`@deepseek-ai/dsh-mcp-gateway` 为每个 attachment 持有一个回环 Streamable HTTP lease。认证先于解析和分发；每个 lease 使用不透明路由与随机 bearer；请求名称会与配置 allowlist 以及定义级别的 `externalEligibility: 'allow'` opt-in 求交集。每次调用在 `ctx.tools.execute` 前提交一个 external call，在之后提交一个 result 或 error；external approval 使用现有 approval service 的持久化 external bracket。

Codex provider 在启动子进程前创建 lease，只把 endpoint 和 `bearer_token_env_var` 写入私有 Codex TOML，并通过该显式环境变量传递 token。lease 处置会在子进程拆除前完成等待。Resume 会写入新的 endpoint 和 token，同时保留哈希 Codex home 及 rollout 状态。

网关强制回环绑定、Streamable HTTP 方法/Accept、content-type/protocol 顺序、严格 JSON UTF-8/请求体字节与时间限制、对秘密键/值及完整本地路径（包括空格）递归脱敏、有界结果、session 所有权，以及路由、工具和处置的故障关闭。脱敏会移除键中的非 ASCII 字母数字字符并转为小写，然后替换已知凭据标记及其加限定词的形式，例如 `apiKeyValue`、`secretValue` 和嵌套的 `tokenValue`；普通的 `key`、`tokenCount` 和 `secretary` 会保留。本地路径脱敏识别 POSIX 根、Windows 驱动器根，以及 server/share 组件均非空并在其后带 `\\` 的 UNC 前缀（例如 `\\server\share\\`），同时保留 `\\Users\\`、`\\home\\`、`\\private\\`、`\\tmp\\`、`\\var\\` 和 `\\opt\\` 这些保留根；已识别路径可以包含空格，没有这些根的文本不会按路径处理。executor 收到原始参数，而持久化 call 副本会脱敏；这是针对已知字段的明确策略，不是对所有秘密的通用检测。lease 创建会拒绝无法放入固定持久化终端 fallback 的已选名称，每个调用还会在 `recordCall` 前预检完整 UTF-8 call envelope 和该 fallback。call-terminal 事件只在权威的 durable call 与 result commit 后发出，并携带 session 所有权。未完成的 recorder call 会在 external scope 关闭前写入一个有界取消结果；同步观察器异常会被隔离，后续监听器和终结仍会继续。Codex provider 对网关的 peer 依赖是可选的，缺少网关时 provider 不产生运行时网关导入；此任务不改变默认 Web profile 或客户端路由。

## Alternatives considered

**直接执行定义。** 拒绝，因为它会跳过工具 guard、approval、验证、渲染、结果观察器和 external 持久化记录。

**伪造原生 Agent 或 turn。** 拒绝，因为 external attachment 没有原生 Agent 生命周期或原生 turn，伪造会让所有权和审计事件不明确。

**把凭据放入 URL 或 TOML。** 拒绝，因为 URL、持久化配置、日志、事件和快照的可见范围都超过子进程环境；显式 bearer 环境变量可保持凭据短暂存在。

## Testing

网关 focused tests 覆盖认证顺序、allowlist/eligibility、MCP session、Streamable HTTP envelope/顺序、尾随 JSON、UTF-8 与 chunked 字节限制、deadline、成功/错误及持久化 call arguments 的结构化递归脱敏、多字节 recorder envelope 精确边界、超大请求零记录拒绝、最小 response budget 拒绝、观察器隔离、处置终结、权威 call/result invariant 以及真实 Loader 组合。Codex tests 覆盖仅通过环境注入 bearer、无网关时的可选 peer 加载、provider 级 gateway start/resume/teardown，以及替换临时 MCP TOML 段并保留 rollout 文件。

## Consequences

MCP surface 有意限制为一个认证回环路由上的工具。工具实现必须观察取消并在 lease 处置完成前结算其拥有的工作。后续任务负责 opt-in bundle 与客户端路由。
