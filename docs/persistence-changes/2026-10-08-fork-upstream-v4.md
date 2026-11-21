---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-fork-upstream-v4

English | [中文](2026-10-08-fork-upstream-v4.zh.md)

## Summary

Retain the fork source marker and continuation attribution on current V4 sessions.

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
## Compatibility

Existing V0–V3 generations remain unchanged. Adjacent migrations preserve the recognized ignorable fork source marker. Current writers use the native plugin-record API with the same type, payload, and ignorable envelope; its declaration is outside SessionEventMap. The historical fork/session-source event remains readable. Wake-scheduler and first-chunk recovery attribution remain optional source metadata. Unknown required events continue to refuse reconstruction.

<a id="verification"></a>
## Verification

Focused Session-format migration and fork source-marker tests pass: 38 files and 1,175 tests.

<a id="dev-note"></a>
## Dev Note

None.
