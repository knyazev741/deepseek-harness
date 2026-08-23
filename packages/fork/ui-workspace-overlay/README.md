# @deepseek-ai/dsh-fork-ui-workspace-overlay

English | [中文](README.zh.md)

The fork-owned browser plugin contributes a `Background` Workspace view, GitHub Actions source badges, and three session-row actions: copy the exact opaque session id, mark the browser-local session watermark unread, and pin or unpin through `ctx.remote.forkWorkspaceSessionState`.

The plugin consumes the public `workspaceContributions` service and `workspace.session-row.badges` / `workspace.session-row.actions` slots from `@deepseek-ai/dsh-client-ui-workspace`. It does not import private upstream UI modules or alter the upstream browser tree. The Host half is intentionally empty; compose `./client` in a web profile together with the generated fork Remote and session-source projection.

Read watermarks persist only under `dsh.fork.workspaceReadWatermarks.v1` and reject malformed localStorage values to an empty map. Pin snapshots remain server-owned, use the observed revision for compare-and-set, refresh once after a stale revision, and never replay a rejected mutation automatically.

## Model Experience

None directly. The overlay changes Workspace navigation and browser-local controls; pin mutations are durable UI state and do not add prompt or transcript content visible to the model.

#### KV Cache effect

None. This plugin does not change model-visible history or prompt assembly.

## Known Limitations and Deferred Work

- Browser-local unread state uses the public summary's optional sequence adapter when available and falls back to `updatedAt` for summaries that do not expose a sequence.
- A stale pin click refreshes the server snapshot but requires a second explicit click, so the browser never guesses a mutation against newer server state.
