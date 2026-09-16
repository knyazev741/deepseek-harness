# `@knyazevai/dsh-fork-base`

[English](README.md) | 中文

可选的 Host fork 组合包：[`cordis.patch.yml`](cordis.patch.yml) 在 [`dsh-base`](../base/README.zh.md) 之后插入四个由独立包拥有的 fork 包，并以可移植的 Knyazev AI 默认值覆盖上游模型行。当部署需要 fork Host 能力和 Knyazev AI 路由时，将此组合包添加到 `@knyazevai/dsh-base` 之后。

## 组合方式

该 patch 先按顺序插入 `fork-session-source`、`fork-workspace-session-state`、`fork-llm-first-chunk-timeout` 和 `fork-llm-rate-limit-cooldown`，再按 id 完整替换上游 `llm-pi-ai` 与 `agent-default-model` 行的 config。超时行携带 `firstChunkIdleTimeoutMs: 120000` 和 `maxFirstChunkCompactionRetries: 100`；冷却行携带 `cooldownMs: 600000`，并在有界 retry 预算耗尽后显式处理 `RATE_LIMIT`、`QUOTA`、`SERVER`、`TIMEOUT`、`FIRST_CHUNK_TIMEOUT`、`TRANSPORT` 和 `PI_AI_ERROR`。模型行配置 `knyazev-ai`，使用 `api: openai-completions` 和 `https://knyazevai.work/v1`，并设置 `streamIdleTimeoutMs: 900000`、`timeoutMs: 1800000`、`compat.thinkingFormat: qwen`、`compat.supportsReasoningEffort: false`、`reasoning: high`，以及 `retryPolicy.mode: normal`、`maxRetries: 20`；可重试代码严格按 `RATE_LIMIT`、`QUOTA`、`SERVER`、`TIMEOUT`、`FIRST_CHUNK_TIMEOUT`、`TRANSPORT`、`STREAM_CLOSED`、`EMPTY_RESPONSE` 排序。其模型为 `deepseek-v4-flash`（context window `400000`、max tokens `128000`）、`glm-5.3-flash`（`400000`、`40000`）、`kimi-2.6`（`262144`、`40000`）和 `minimax-2.7`（`204800`，不覆盖 max-token）。default-model 行选择 `knyazev-ai/deepseek-v4-flash`，并有意不在 composition 中携带 `reasoningEffort` 字段。

路由只保存凭据引用 `apiKeyEnv: KNYAZEV_AI_API_KEY`；密钥值保留在外部凭据或环境层，绝不进入 Git。用户 settings 文档位于该 composition base 之上，因此不完整的 `llm-pi-ai` 或 `agent-default-model` 设置会覆盖对应字段，省略字段则继承可移植默认值。profile、home 或 `--patch` 行仍会按 id 整体替换目标插件的 config。该组合包不挂载 provider-neutral external-session registry，也不挂载 Codex provider。

会话状态行等待 Host 表层提供 `workspaceRegistry`。这样 fork 组合包可以在不同 Host 组合中复用，同时保持 Loader 的依赖顺序。

## 挂载的能力

- [`fork-session-source/`](../../fork/session-source/README.zh.md) 记录可选的 GitHub Actions 来源标记，并提供可空 projection。
- [`fork-workspace-session-state/`](../../fork/workspace-session-state/README.zh.md) 持久化有序的工作区会话置顶列表，并提供生成的 Remote。
- [`fork-llm-first-chunk-timeout/`](../../fork/llm-first-chunk-timeout/README.zh.md) 限制 LLM 流首个结果之前的空闲等待，并在压缩产生持久进展后于新一轮排入 `continue` follow-up。
- [`fork-llm-rate-limit-cooldown/`](../../fork/llm-rate-limit-cooldown/README.zh.md) 在 provider 的有界 `llm-retry` 预算耗尽后，等待 `cooldownMs` 再重试持续受限（`RATE_LIMIT`、`SERVER`、`QUOTA`、`TIMEOUT`、`TRANSPORT`、`PI_AI_ERROR`，以及该组合包中的 `FIRST_CHUNK_TIMEOUT`）的请求。

每项能力仍由自己的包拥有；上游 base 更新时可以分别移除或替换它们。

## 模型体验

### Host 表层行

#### 模型看到的内容

不会添加 prompt section 或工具 schema。可移植路由会改变默认 provider/model 和请求 endpoint。首个分片超时恢复成功压缩后，会添加一条内容为 `continue`、由插件生成的持久 user-role 消息，并开启新请求；来源和置顶行始终仅属于 Host。

#### Token 影响

成功请求为零。首个分片超时恢复成功时，会在压缩后添加短消息 `continue` 和一次新的模型请求。

#### KV Cache 影响

首个分片超时恢复成功时会使用压缩后的替换 surface 并追加 `continue`，因此该新请求具有不同的模型可见前缀。未进入恢复路径的请求不受影响。

## 已知限制与延期工作

- 工作区会话状态行需要提供 `workspaceRegistry` 的 Host 组合；不挂载该服务的 profile 会让该行等待其声明的依赖。
- Knyazev AI 请求鉴权前必须通过进程环境或 credentials service 解析 `KNYAZEV_AI_API_KEY`；缺少该值时请求会失败，而该值不会写入组合包。
- 用户 settings 分节可以替换可移植 provider 或 default-model 值，后续 patch 也可以按 id 整体替换它们的插件 config。
- 该组合包有意将 external-session provider 选择和 Codex 集成留给未来显式组合的 overlay。
