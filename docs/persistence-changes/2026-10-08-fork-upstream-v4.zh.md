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
    previous: "2026-11-05-timeline-priority-notice"
    after: "90dcd45ecda350667dc3953acba41c5f38230ea25d2ee06177532670fc94ade9"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "8f268993ffec91161407e2a63b52e4715921c5285691b5342082402334882d16"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "cae6d0333d8d52bc2290170c507ca2ea213d9e52a7540d6f94f51c2beadf8707"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "b700c65c16c32241dc947e69f0198ea7da16366a878eeb5c8db4e6885fd3d4c5"
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
