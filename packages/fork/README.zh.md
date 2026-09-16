---
description: "分支发行版的包职责和配置。"
kind: "package-group"
---

# fork/：fork 所有的能力覆盖层

[English](README.md) | 中文

## 概述

fork 组包含选择性启用的 Host 能力；这些能力保持为独立插件，同时共享 harness 的 session 与 projection 接缝。除非部署显式组合，否则普通 profile 不会挂载这些包。

## Packages

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-source/`](session-source/README.zh.md) | 记录并投影 GitHub Actions 会话来源 | `forkSessionSource` 投影 |
| [`workspace-session-state/`](workspace-session-state/README.zh.md) | 持久化工作区会话的全局有序置顶列表 | `forkWorkspaceSessionState` |
| [`ui-workspace-overlay/`](ui-workspace-overlay/README.zh.md) | 添加后台筛选、来源标记、本地未读标记，以及基于 CAS 的置顶/会话操作 | `workspaceContributions` + 工作区会话行 slot |
| [`llm-first-chunk-timeout/`](llm-first-chunk-timeout/README.zh.md) | 限制 LLM 流首个结果之前的空闲时间 | `llm/stream` waterfall |
| [`llm-rate-limit-cooldown/`](llm-rate-limit-cooldown/README.zh.md) | 在 `llm-retry` 预算法尽后等待长时间冷却并重试限流请求 | `agent/request-error` waterfall |
| [`external-session/`](external-session/README.zh.md) | 按 mode 注册显式组装的外部会话 provider | `externalSessions` |

每个包负责自己的持久事件、投影或服务契约、不变量伴侣和生命周期清理。该组不会改变 `SessionHeader` 或模型可见的会话表面。

所属子系统参见 [LLM](../../docs/subsystems/llm-streaming.zh.md) 和 [Web 客户端](../../docs/subsystems/web-client.zh.md)。
