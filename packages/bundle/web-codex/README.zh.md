# `@deepseek-ai/dsh-web-codex`

[English](README.md) | 中文

可选的 Codex Web bundle。[`cordis.patch.yml`](cordis.patch.yml) 在 [`dsh-base`](../base/README.md) 与 [`dsh-web-app`](../web-app/README.md) 之后应用，并且恰好插入一行 external-session registry、一行 permission bridge、一行 Codex provider、一行 external-session bridge 与一行经过认证的 loopback [`mcp-gateway`](../../mcp/mcp-gateway/README.md)。默认的 `web` profile 不包含这一层，因此不会启动 Codex app-server，也不会在 `session.externalModes` 中公告 Codex。

该 patch 不把凭证写进 YAML。provider 在没有进程环境中的非敏感 `DSH_CODEX_COMMAND` 可执行文件覆盖时使用打包的 `@openai/codex` launcher，在 `dshHomePath('external-codex')` 下保存每个会话的 `CODEX_HOME` 状态，并验证 command 参数、绝对 state root、空的 external-tool allowlist、进程处置上限与 30000 毫秒 preflight 截止时间。gateway 以空 allowlist 启动，并明确设置 65536 字节请求／响应上限与 60000 毫秒执行截止时间；后续本地 overlay 可以只加入经过审查且符合条件的工具，并且必须保留有效上限。provider preflight 会在 mode 被报告可用或 session 被发布前检查可执行文件、账户状态与 sandbox；截止后会中止 wire、回收子进程树、删除 probe 状态，并报告 `PREFLIGHT_FAILED`。

要创建本地可选 profile，请把 Web 与 Codex 层安装到一个新 profile 中（第一条命令会以 `dsh-base` 初始化它），然后启动：

```sh
dsh plugin --profile codex-web add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-web-codex
dsh --profile codex-web
```

overlay 可以把 `external-session-codex.config.command` 设置为经过审查的可执行文件路径，也可以设置 `allowedTools`、`preflightTimeoutMs` 或 gateway 上限；不要把 API key、bearer token 或其他凭证写进 `cordis.patch.yml`。缺少依赖，或把没有 `dsh.bundle.patch` manifest 声明的包列为 bundle，都会在 profile 解析时直接报错。

## 模型体验

间接通过独立的 Codex 进程与 Web 对其持久化 transcript 的投影产生影响；该 bundle 不向父 Harness 的 model prompt 或原生 DSH model request 添加内容。

#### KV Cache 影响

没有直接影响；原生 DSH 前缀保持不变，外部 conversation 的缓存由 Codex 负责。

## 已知限制与暂缓事项

- **该 bundle 默认关闭**——随附的 `web` profile 只有在用户加入这一层后才会启用外部 provider。
- **外部输入目前仅支持文本**——图片、排队 prompt、steering 与原生 goals 会返回明确的不支持错误；`/compact` 与 `/model` 保留提供方专用路由，其他 slash 行通过 `session.command` 传递。
- **浏览器验收仍属于 Task 9**——本任务覆盖 service、client 与组合 smoke 测试；组装浏览器 E2E 与面向用户的快照仍然延后。
