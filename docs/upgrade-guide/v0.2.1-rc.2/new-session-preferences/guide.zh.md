---
kind: upgrade-guide
description: 显式权限命令也会改变未来会话的默认值，模型选择会等待默认值持久化。
---

# 新会话偏好设置

[English](guide.md) | 中文

## 变更

`/permission <preset>` 命令将配置预设保存为未来 Session 的 profile 默认值。现有 Session 保留自己的权限。Auto 仅作用于当前会话，程序调用 `permissionPresets.set()` 不会改变默认值。profile 写入失败时，会报告 Session 已改变，但新会话默认值未保存。

新聊天创建会先等待已接收的 profile 编辑结束，再读取默认值。`session.selectModel` 会等待默认值保存尝试完成后再确认选择。写入失败时，Session 级选择仍然生效，并记录警告。优先级更高的 home 或命令行覆盖仍然具有权威性，可能阻止 profile 写入。

## 迁移

1. 检查配置的权限预设。选择 Full access 也会将其设为后续创建 Session 的默认值；选择配置的审批预设会再次改变默认值。自定义集成若只需要改变当前 Session，应使用 `permissionPresets.set()`。
2. 如果模型选择器返回过时默认值，停止 profile 后，从 `$DSH_HOME/cordis.patch.yml` 或固定它的命令行 overlay 中移除 `agent-default-model` 覆盖。保留提供方定义和凭据；只需移除默认模型行。
3. 选择可用模型和权限预设，创建新聊天，并确认两项选择。重新打开旧聊天，确认其权限仍然独立。
