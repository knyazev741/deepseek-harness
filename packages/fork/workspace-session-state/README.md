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

The service waits for `settings` and `workspaceRegistry`. Its Settings namespace is exactly `fork-workspace-session-state`, and the persisted value is `{ pins: { sessionIds: string[] } }`. The Settings descriptor revision is the only revision exposed by the service.

<a id="host-service-and-remote"></a>
## Host service and Remote

The Host service is available as `ctx.forkWorkspaceSessionState`. Its generated Remote namespace is `forkWorkspaceSessionState` and contains only these methods:

- `list()` returns `{ revision, pinnedSessionIds }`.
- `setPinned({ sessionId, pinned, expectedRevision })` returns a success value or a typed `revision-conflict` / `session-not-in-workspace` result.

`workspaceRegistry.list()` is authoritative when admitting a new pin. A pin is appended once, an unpin retains the relative order of other pins, and an idempotent request performs no Settings write. An existing persisted pin can always be removed after its session leaves the registry, including after archival or Workspace deletion. Mutations are serialized and use the Settings descriptor revision for compare-and-set. Stale requests are checked before idempotence, and a competing Settings write is returned as the same typed revision conflict. Persisted pins are retained when workspace membership later changes until an explicit unpin removes them.

The generated `./remote` and `./typert` artifacts are produced by the Host build. The API Proxy is unchanged; a Client assembly may mount this namespace through `packages/api/remotes`.

<a id="model-experience"></a>
## Model Experience

None, as this service stores Host workspace state and contributes no prompt, tool, or model-request content.

#### KV Cache effect

None; pin state is not included in model-visible input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The package provides no UI. A future Client contribution may render and edit the list through the generated Remote.
- Membership is checked when a new pin is admitted. Existing pins are not pruned when the workspace registry changes, but explicit unpin remains available.
- The list is global to the currently composed workspace registry; the Remote intentionally has no `workspaceId` field.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintenance context</summary>

Retain focused fork tests when adapting this package to upstream APIs. Configuration and behavior are documented above.

</details>
