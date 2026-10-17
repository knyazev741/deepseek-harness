---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-fork-upstream-v4

[English](2026-10-08-fork-upstream-v4.md) | 中文

## 概述

在当前 V4 会话中保留分支来源标记与继续执行的归属信息。

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
    previous: "2026-10-13-user-rpc-principal"
    after: "9308eeca974942d895e0f6a503fe3919331061373a87acd003ade30104ba462f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "bd513c6a8a40609220d4e2ddc91e3752fbc67eff44a78255557893aadbe7d069"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "f5b9422088c2dcf7419b0e4df9cbb9ad12e1a36bcfeeee4dbb91349b7da86c5e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "57d2ce8a691e6ff2c23d362810a0dd25d9d48372e63801faf961ba8de21734f8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 V0–V3 代际文件保持不变。相邻迁移保留已识别的 ignorable 分支来源标记。当前写入方使用原生插件记录 API，保持相同的类型、载荷和 ignorable 信封；声明位于 SessionEventMap 之外。历史 fork/session-source 事件仍然可读。唤醒调度与首块恢复的归属信息仍是可选来源元数据。未知必需事件仍会拒绝重建。

<a id="verification"></a>
## 验证

聚焦的 Session 格式迁移与分支来源标记测试通过：38 个文件、1,175 个测试。

<a id="dev-note"></a>
## 开发备注

无。
