# Agent Note: Authenticated loopback MCP gateway for external Codex

Status: implemented

[English](2026-08-20-authenticated-mcp-gateway.md) | 中文

## Problem

外部 Codex attachment 需要本地 Harness 工具目录，同时不能绕过 external-principal 流水线、创建原生 Agent，或把 bearer 凭据放入持久化及模型可见数据。

## Decision

`@deepseek-ai/dsh-mcp-gateway` 为每个 attachment 持有一个回环 Streamable HTTP lease。认证先于解析和分发；每个 lease 使用不透明路由与随机 bearer；请求名称会与配置 allowlist 以及定义级别的 `externalEligibility: 'allow'` opt-in 求交集。每次调用在 `ctx.tools.execute` 前提交一个 external call，在之后提交一个 result 或 error；external approval 使用现有 approval service 的持久化 external bracket。

Codex provider 在启动子进程前创建 lease，只把 endpoint 和 `bearer_token_env_var` 写入私有 Codex TOML，并通过该显式环境变量传递 token。lease 处置会在子进程拆除前完成等待。Resume 会写入新的 endpoint 和 token，同时保留哈希 Codex home 及 rollout 状态。

网关强制回环绑定、严格方法和 JSON UTF-8/请求体限制、协作式截止时间、session 所有权，以及路由、工具和处置的故障关闭。网关和 Codex provider 仍是可选消费者；此任务不改变默认 Web profile 或客户端路由。

## Alternatives considered

**直接执行定义。** 拒绝，因为它会跳过工具 guard、approval、验证、渲染、结果观察器和 external 持久化记录。

**伪造原生 Agent 或 turn。** 拒绝，因为 external attachment 没有原生 Agent 生命周期或原生 turn，伪造会让所有权和审计事件不明确。

**把凭据放入 URL 或 TOML。** 拒绝，因为 URL、持久化配置、日志、事件和快照的可见范围都超过子进程环境；显式 bearer 环境变量可保持凭据短暂存在。

## Testing

网关 focused tests 覆盖认证顺序、allowlist/eligibility、MCP session、尾随 JSON、UTF-8 与字节限制、截止时间、approval、recorder 成对事件、处置以及真实 Loader 组合。Codex unit tests 覆盖仅通过环境注入 bearer，以及替换临时 MCP TOML 段并保留 rollout 文件。

## Consequences

MCP surface 有意限制为一个认证回环路由上的工具。工具实现必须观察取消并在 lease 处置完成前结算其拥有的工作。后续任务负责 opt-in bundle 与客户端路由。
