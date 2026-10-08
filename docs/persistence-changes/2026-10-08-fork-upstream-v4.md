---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-fork-upstream-v4

English | [中文](2026-10-08-fork-upstream-v4.zh.md)

## Summary

Retain fork source markers and continuation attribution on the upstream Session format.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The adjacent upstream migration renames the ignorable fork/session-source event to plugin:fork/session-source while preserving its literal payload. Released historical generations remain unchanged. Wake scheduler and first-chunk recovery sources are attribution-only additions: readers preserve their messages without requiring either producer.

<a id="verification"></a>
## Verification

Focused session-migrate catalog, fork session-source, first-chunk timeout and wake-scheduler tests pass on the merged implementation.

<a id="dev-note"></a>
## Dev Note

None.
