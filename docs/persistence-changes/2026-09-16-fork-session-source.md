---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-16-fork-session-source

English | [中文](2026-09-16-fork-session-source.zh.md)

## Summary

Preserve the fork/session-source event in the upstream persistence inventory.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

This additive log-only event requires ignorable: true and the exact source github-actions. Historical formats 0, 1, and 2 accept it through a separate fork disposition table; released upstream inventories remain unchanged. Readers may skip this event without changing the model-visible surface. No version bump is required.

<a id="verification"></a>
## Verification

The session migration suite passed 808 tests, including preservation and validation of the fork marker across historical formats.

<a id="dev-note"></a>
## Dev Note

None.
