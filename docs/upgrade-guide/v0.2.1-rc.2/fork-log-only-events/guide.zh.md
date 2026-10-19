---
kind: upgrade-guide
description: 分支专有的 LogIntent API 已从 Session.append 移除。
---

# 分支仅写日志的事件

[English](guide.md) | 中文

## 变更

分支专有的 `LogIntent` 类型与 `Session.append` 的 `{ ignorable: true }` 选项已移除。内置 GitHub Actions 来源插件通过 plugin-record 写入器写入 `plugin:fork/session-source`，并同时读取该记录与历史 `fork/session-source` 事件。现有 Session 日志无需改写标记即可读取。

## 迁移

1. 从自定义 `Session.append` 调用中移除 `LogIntent` 导入与 ignorable 参数。普通的已声明 Session 事件使用 `Session.append`，读取方必须知道对应事件类型。
2. 使用内置 [`fork-session-source` 插件](../../../../packages/fork/session-source/README.zh.md)记录 GitHub Actions 来源元数据。不要手工追加它的标记。
3. 重新构建自定义插件，并打开一个已有标记的 Session，确认其 GitHub Actions 来源仍然可见。
