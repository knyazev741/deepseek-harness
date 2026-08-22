# fork/：fork 所有的能力覆盖层

[English](README.md) | 中文

fork 组包含选择性启用的 Host 能力；这些能力保持为独立插件，同时共享 harness 的 session 与 projection 接缝。除非部署显式组合，否则普通 profile 不会挂载这些包。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-source/`](session-source/README.zh.md) | 记录并投影 GitHub Actions 会话来源 | `forkSessionSource` 投影 |

每个包负责自己的持久事件、投影或服务契约、不变量伴侣和生命周期清理。该组不会改变 `SessionHeader` 或模型可见的会话表面。
