---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-fork-upstream-v4

[English](2026-10-08-fork-upstream-v4.md) | 中文

## 概述

在上游 Session 格式中保留分支来源标记与继续消息归属。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-fork-upstream-v4
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "4c24bd680e273b5e065ba81faa73650169fff2210be427ba015bdba5ced4f543"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "14913187742aa0d062da7382b5ded7bef4bb7ea64a663f209795fce8417e9ee7"
    decision: same-version
  - root: "event:plugin:fork/session-source"
    previous: null
    after: "3aaa59a268212c86eccaca795786af10d541233f52f13ffe6b97393a8f8db554"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "2282e7cac04d81b50903c710052bfc3b1f0a93201aaf47d6910bbe8ecf67460f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "291943d7629883cefd30b18c0f8775f7d3a76e8860f3fd2cf8b7414a0672fe53"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

相邻的上游迁移将可忽略的 fork/session-source 事件重命名为 plugin:fork/session-source，并保留其字面载荷。已发布的历史代文件保持不变。唤醒调度器与首块恢复来源仅增加归属信息：读取器保留这些消息，无需加载相应生产者。

<a id="verification"></a>
## 验证

合并实现通过了 session-migrate catalog、分支 session-source、首块超时与 wake-scheduler 的针对性测试。

<a id="dev-note"></a>
## 开发备注

无。
