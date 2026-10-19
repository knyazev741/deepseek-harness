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
## Compatibility

Existing V0–V3 generations remain unchanged. Adjacent migrations preserve the recognized ignorable fork source marker. Current writers use the native plugin-record API with the same type, payload, and ignorable envelope; its declaration is outside SessionEventMap. The historical fork/session-source event remains readable. Wake-scheduler and first-chunk recovery attribution remain optional source metadata. Unknown required events continue to refuse reconstruction.

<a id="verification"></a>
## Verification

Focused Session-format migration and fork source-marker tests pass: 38 files and 1,175 tests.

<a id="dev-note"></a>
## Dev Note

None.
