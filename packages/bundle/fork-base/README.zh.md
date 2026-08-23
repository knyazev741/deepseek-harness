# `@deepseek-ai/dsh-fork-base`

[English](README.md) | 中文

可选的 Host fork 组合包：[`cordis.patch.yml`](cordis.patch.yml) 在 [`dsh-base`](../base/README.zh.md) 之后插入三个由独立包拥有的 fork 包。当部署需要会话来源、工作区置顶状态以及 LLM 流首个结果之前的有界等待时，将此组合包添加到 `@deepseek-ai/dsh-base` 之后。

## 组合方式

该 patch 仅包含 insert。它按顺序添加 `fork-session-source`、`fork-workspace-session-state` 和 `fork-llm-first-chunk-timeout`。超时行携带显式且经过校验的 `firstChunkIdleTimeoutMs: 120000`；profile 或后续 `--patch` 层可以按 id 禁用或重新配置任意一行。该组合包不挂载 provider-neutral external-session registry，也不挂载 Codex provider。

会话状态行等待 Host 表层提供 `workspaceRegistry`。这样 fork 组合包可以在不同 Host 组合中复用，同时保持 Loader 的依赖顺序。

## 挂载的能力

- [`fork-session-source/`](../../fork/session-source/README.zh.md) 记录可选的 GitHub Actions 来源标记，并提供可空 projection。
- [`fork-workspace-session-state/`](../../fork/workspace-session-state/README.zh.md) 持久化有序的工作区会话置顶列表，并提供生成的 Remote。
- [`fork-llm-first-chunk-timeout/`](../../fork/llm-first-chunk-timeout/README.zh.md) 仅限制 LLM 流首个结果之前的空闲等待。

每项能力仍由自己的包拥有；上游 base 更新时可以分别移除或替换它们。

## 模型体验

### Host 表层行

#### 模型看到的内容

不会添加 prompt section、工具 schema、消息或请求字段。组合包的超时行只在 provider 未在配置期限内产生首个结果时改变失败路径；来源和置顶行始终仅属于 Host。

#### Token 影响

成功请求为零。首个结果超时会用一条终结性的 `TIMEOUT` 失败 chunk 替代缺失的 provider 结果，但自身不会添加重试请求。

#### KV Cache 影响

所挂载的包不改写模型可见输入，也不改变成功请求的前缀，因此没有直接的缓存失效。

## 已知限制与延期工作

- 工作区会话状态行需要提供 `workspaceRegistry` 的 Host 组合；不挂载该服务的 profile 会让该行等待其声明的依赖。
- 该组合包有意将 external-session provider 选择和 Codex 集成留给未来显式组合的 overlay。
