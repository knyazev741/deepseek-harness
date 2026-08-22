# @deepseek-ai/dsh-client-ui-session-mode

[English](README.md) | 中文

Web 新建会话模式选择器：创建会话时的「模式」席位，在原生 DSH 智能体循环（`dsh`）与每个已注册的外部控制台智能体（Codex 等）之间选择；选中外部模式时，还会提供由该提供方模型目录驱动的模型席位。

## 角色

这是一个纯客户端插件。它消费外部交互式智能体会话功能所构建的宿主表面：

- `session.create` 在宿主入口接收并校验 `mode`（任务 3）：缺省/`dsh` 创建原生智能体循环；已注册的外部提供方名称则创建不带原生 Agent、并以 `header.mode` 打标、由 external-session-bridge 驱动持有的裸会话。
- 外部会话注册表（`ctx.externalSessions`）负责回答提供方目录（`listAgents`）以及每种模式下的模型目录（`listModels`），遵循与 `session.models` 相同的按会话通道。

选择器只是这些表面之上的表现层：它根据注册表渲染模式行，为所选外部模式启用模型席位，并以 `mode` + `model` 提交创建。

## 模型影响

本包对任何父会话没有模型可见的影响。它渲染新建会话席位；它帮助创建的底层会话要么是原生智能体循环（行为不变），要么是外部模式会话——其活动以仅日志的 `external/*` 事件族（`packages/session/session-projection`）投影。选择器本身从不向模型请求输送内容。所有产品文案为中文；代码注释为英文。
