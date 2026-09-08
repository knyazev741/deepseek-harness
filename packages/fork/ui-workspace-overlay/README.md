# @knyazevai/dsh-fork-ui-workspace-overlay

English | [中文](README.zh.md)

The fork-owned browser plugin contributes GitHub Actions source badges and three session-row actions: copy the exact opaque session id, mark the browser-local session watermark unread, and pin or unpin through `ctx.remote.forkWorkspaceSessionState`.

The `Background` Workspace view is intentionally **not** contributed while the background feature is not ready, so the Workspaces UI shows only the built-in Workspaces view. It was previously registered as a `fork.background` view filter over running or GitHub Actions sessions; re-enable it by contributing such a view from `apply` when the feature lands.

The plugin consumes the public `workspaceContributions` service and `workspace.session-row.badges` / `workspace.session-row.status` / `workspace.session-row.actions` slots from `@knyazevai/dsh-client-ui-workspace`. Built-in pending, activity, and completion statuses own the left cell whenever present; the unread contribution fills only its idle state, so one row never renders duplicate status dots. The plugin does not import private upstream UI modules or alter the upstream browser tree. The Host half is intentionally empty; compose `./client` in a web profile together with the generated fork Remote and session-source projection.

Read watermarks persist only under `dsh.fork.workspaceReadWatermarks.v1` and reject malformed localStorage values to an empty map. The current-session subscription advances the watermark through every visible projection update; entering a session also clears its explicit Mark unread state, while later visible updates do not. Pin snapshots remain server-owned and use the observed revision for compare-and-set. A revision conflict refreshes the authoritative Host snapshot, accepts a revision reset caused by a Host restart, and replays the same explicit pin intent once.

## Model Experience

None, as the browser-only overlay changes Workspace controls and contributes no model context.

#### KV Cache effect

None. This plugin does not change model-visible history or prompt assembly.

## Known Limitations and Deferred Work

- Browser-local unread state uses the public summary's `projectionAsOfSeq` when the Host supplies a projection cut; summaries without that durable sequence do not advance a watermark.
