---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-16-fork-session-source

[English](2026-09-16-fork-session-source.md) | 中文

## 概述

在上游持久化清单中保留 fork/session-source 事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-16-fork-session-source
baseline: false
changes:
  - root: "event:fork/session-source"
    previous: null
    after: "a0c62a56072e68f47eab94ede3cd898c4dfb75f3c0b239791728eac1c9441f3e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这个新增的纯日志事件要求 ignorable: true 和精确的来源 github-actions。历史格式 0、1、2 通过独立的分支处置表接受它；已发布的上游清单保持不变。读取器可以跳过此事件而不改变模型可见的会话表面，因此无需提升版本。

<a id="verification"></a>
## 验证

会话迁移测试通过了 808 项测试，包括历史格式中的分支标记保留与验证。

<a id="dev-note"></a>
## 开发备注

无。
