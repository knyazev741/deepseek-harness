# Agent Note: 可选的 Codex Web mode

Status: implemented

[English](2026-08-20-opt-in-codex-web-mode.md) | 中文

## Problem

外部 Codex 会话提供方已经可以驱动持久会话，但随附的 Web profile 不能启动本地 app-server、公告部署无法使用的 mode，也不能把 external 文本送入原生 Agent command registry。用户还需要让选定的 mode 在客户端列表刷新、创建 frame 与重连后保持不变。

## Decision

`@deepseek-ai/dsh-web-codex` 是位于 `dsh-base` 与 `dsh-web-app` 之后的独立 profile patch。它恰好挂载一次 external-session registry、permission bridge、Codex provider、session bridge 与 MCP gateway；默认 Web patch 仍然只有原生模式。该 patch 不包含凭证，并以空 external-tool allowlist 以及有界的 gateway 请求、响应、权限和进程超时启动。

External provider 暴露类型化 preflight 结果。Host 在 `session.externalModes` 公告目录前以及发布 external session 前各运行一次。二进制、认证、配置与 sandbox 失败都携带稳定分类，并且不会留下 session 行。Codex preflight 在私有临时 state root 中检查配置的 app-server 账户与模型 surface，完成后删除 probe root。它有经过验证的正有限 `preflightTimeoutMs` 截止时间（默认 30000 毫秒）；超时会中止 wire、回收 probe 进程树、删除 root，并返回有界的 `PREFLIGHT_FAILED` 结果。

浏览器把持久 mode 保存到每个 session 对象和列表行。External 文本 prompt 与 provider 自有 slash 行使用 `api.sessions.command`；`/compact` 与 `/model` 仍由 Host 执行 provider 专用操作。图片、队列编辑、steering 与原生 goal command 都会返回明确的本地错误，并且不查找原生 Agent。启动 external turn 的 command 会持续 pending，直到其 provider 签发的轮次身份对应的持久化 `external/turn-ended` 事件抵达；没有该身份的响应使用已观察到的 sequence fence，因此旧终态不能释放 cold 或 loading command。

## Alternatives considered

**把 Codex 挂载到默认 Web patch。** 否决：安装本地 external process 并暴露认证 mode 会改变每个 Web 部署的安全与依赖姿态。可选 bundle 让用户明确作出选择。

**External routing 不可用时回退到原生 Agent。** 否决：这会让持久 external mode 在不同 driver 下运行，并可能暴露原生工具或静默丢失用户输入。Host 改为报告类型化失败。

**把 external 普通 prompt 送入原生 command registry。** 否决：external session 有意不创建原生 Agent。专用 `session.command` route 保留 provider 的 command namespace，并避免 Agent lookup。

## Consequences

Bundle README 记录了本地 profile 命令；缺少必要 bundle 依赖时，profile resolution 会直接失败。Codex provider 仍然要求用户自行完成本地登录；凭证不会进入 YAML、日志、事件、URL 或快照。External transcript 由仅日志事件投影，因此不会改变父 DSH 的 model-visible request。浏览器 E2E、组装 transcript 快照以及最终的本地认证验收仍属于 Task 9。
