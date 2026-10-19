---
description: "Fork distribution package ownership and configuration."
kind: "package-reference"
---

# @knyazevai/dsh-fork-workspace-session-state

English | [中文](README.zh.md)

## Summary

Host service for one ordered pin list shared by the sessions attached to the current workspace registry. The package is private and opt-in; it is not included by an ordinary profile.

## Table of Contents

- [Composition](#composition)
- [Host service and Remote](#host-service-and-remote)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="composition"></a>
## Composition

```yaml
- id: fork-workspace-session-state
  name: '@knyazevai/dsh-fork-workspace-session-state'
```

The service waits for `settings` and `workspaceRegistry`. Its legacy Settings namespace `fork-workspace-session-state` accepts `{ pins: { sessionIds: string[] } }`; the adapter imports known, unarchived sessions into native Workspace persistence in the saved order, then clears the legacy list.

<a id="host-service-and-remote"></a>
## Host service and Remote

The Host service is available as `ctx.forkWorkspaceSessionState`. Its generated Remote namespace is `forkWorkspaceSessionState` and contains only these methods:

- `list()` returns `{ revision, pinnedSessionIds }`.
- `setPinned({ sessionId, pinned, expectedRevision })` returns a success value or a typed `revision-conflict` / `session-not-in-workspace` result.

`workspaceRegistry.list()` admits new pins. Native Workspace actions own persistence and ordering, including removing pins on archive. Adapter calls are serialized; its observed revision detects stale callers within this process and resets on restart. Native UI actions use the Workspace API directly.

The generated `./remote` and `./typert` artifacts are produced by the Host build. The API Proxy is unchanged; a Client assembly may mount this namespace through `packages/api/remotes`.

<a id="model-experience"></a>
## Model Experience

None, as this service stores Host workspace state and contributes no prompt, tool, or model-request content.

#### KV Cache effect

None; pin state is not included in model-visible input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The package provides no UI. Native Workspace row actions render and edit pins.
- Legacy unknown or archived pins are discarded during import.
- The list is global to the currently composed workspace registry; the Remote intentionally has no `workspaceId` field.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintenance context</summary>

Retain focused fork tests when adapting this package to upstream APIs. Configuration and behavior are documented above.

</details>
