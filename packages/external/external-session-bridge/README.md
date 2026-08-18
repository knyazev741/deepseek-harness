# @deepseek-ai/dsh-external-session-bridge

English | [中文](README.zh.md)

Host-plane bridge driver for external interactive agent sessions ([`external-session`](../external-session/README.md)). This function plugin connects the external-session registry (`ctx.externalSessions`) to real host sessions created in an external mode. When a session enters the host store whose durable header `mode` names a registered external provider, this driver starts that provider's live session on the pre-reserved session id; the activity the provider writes through its per-session bridge lands in the owning session's durable log as log-only `external/*` events. The driver also registers the [external-transcript projection unit](../../session/session-projection/README.md) so replay and client rendering never re-walk the raw event log, and it disposes the provider's process tree when the session closes.

The mode-aware creation decision (stamp `mode` on the durable header and create the session *without* a native Agent for an external mode) lives in the session-create gateway, [`dsh-host-apiproxy`](../../host/apiproxy/README.md). This plugin only reacts to already-stamped sessions, so it composes wherever the external-session family is mounted.

## Lifecycle

Loading the plugin registers the transcript projection and reacts to two lifecycle events for the lifetime of its fibre:

- `session/created` — when a session's header `mode` names a registered provider (and is not `dsh`, the native-agent default), the driver starts that provider on the session id. A session created in a mode with no registered provider fails loud at creation (the driver refuses to strand the session).
- `session/disposed` — the driver disposes the provider for sessions it started, tearing down the external process tree.

A provider's `start` rejection is an asynchronous, post-publication failure it cannot unwind, so it surfaces on the typed host event `external/session-bridge/error` rather than being silently dropped.

## Model Experience

None in parent `dsh` sessions: the activity projected here is external-agent activity recorded as log-only `external/*` events, and nothing reaches a parent model request. The external agent it drives is outside the parent's agent loop.

#### KV Cache effect

None; the driver appends nothing to any request prefix.

## Known Limitations and Deferred Work

- **Live-frame delta routing is a client phase** — the provider bridge's `streamDelta` is owned by the `external-session` service and is not wired to the frame channel here; live incremental deltas and their UI seats are later (client) phases.
- **Create-time only** — this driver reacts to newly created sessions; reattaching a cold external session on restart (resume of a previously started external session) is a later phase.
