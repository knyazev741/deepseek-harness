# @deepseek-ai/dsh-external-session

English | [中文](README.zh.md)

External interactive-agent session Service Definition. Owns the `ctx.externalSessions` service contract ([`ExternalSessionsService`](src/types.ts)): a named-provider registry whose providers drive live sessions on behalf of an external agent process (Codex, Claude Code, an ACP client), plus the per-session bridge handed to a provider at start. As the Service Definition role of the [capability-seam split](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md), it depends only on cordis, the branded-id primitive, the session envelope types, and the harness error base — never on a concrete external agent or its wire protocol. The first provider (`external-session-codex`) and the host bridge driver are separate packages that consume this seam's contracts. The design and phase sequencing live in [the external interactive agent sessions spec note](../../../.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md).

The contract in one line: a registry maps unique provider names (`provider`, also the session mode id) to [`ExternalSessionProvider`](src/types.ts) implementations; `start(request)` resolves the provider, records the session-to-provider route, and hands it a live [`ExternalBridgeContext`](src/types.ts) — `appendEvent` (log-only session events), `requestPermission` (ask the human), `streamDelta` (live-only deltas), and a `disposal` signal. Later calls — `prompt`, `interrupt`, `setModel`, `dispose` — take only the session id and dispatch to the owning provider.

The registry is effect-scoped HMR-safe: `registerProvider(provider)` returns the exact Cordis effect disposer. Removing a provider blocks new starts but does not revoke live sessions already returned to their holders.

## Registry

- `listAgents()` — descriptors of every registered provider, in insertion order (`provider`, `label`, `modelDirectory`). The label feeds the mode picker; Chinese product copy lives client-side.
- `registerProvider(provider)` / `getProvider(name)` / `list()` — the registry surface; registration is effect-scoped and emits `external/provider-added` / `external/provider-removed`.
- `modelDirectory` — `'provider'` (native catalog) or `'config'` (validated roster owned by the provider). `listModels(provider)` always dispatches to the named provider, which answers from whichever surface its directory names.

Modes are not presets: choosing one composes the same host process and fixes the driving backend. Session creation with a `mode` is a later host phase; this package pre-receives a reserved [`SessionId`](../../core/session/) at `start` and never invents one.

## Bridge

`start` hands each provider one per-session [`ExternalBridgeContext`](src/types.ts):

- `appendEvent(sessionId, event)` — writes a writer-side event fragment into the durable session log when a live session is registered (log-only, `ignorable: true`); otherwise drops it. Sequencing and the `ignorable` marker are stamped by the session, not the caller.
- `requestPermission(sessionId, ask)` — fails closed while no permission channel is wired (rejects `PERMISSION_UNWIRED`); the ask-user bridge is a host responsibility.
- `streamDelta(sessionId, turnId, delta)` — forward-only live deltas, never durable.
- `disposal` — an `AbortSignal` that fires when the session is disposed, so the provider can tear down its process.

## Events

Context events (this package): `external/provider-added` and `external/provider-removed` carry the registry↔descriptor transitions.

The durable `external/*` session-log event vocabulary (session-started, turn-started, message-added, tool-activity, permission-asked/decided, model-switched, compaction-noticed, turn-ended, session-ended) is merged into the session `SessionEventMap` by a later phase and projected for replay; this package only routes them through `appendEvent` and does not teach their names.

## Model Experience

### External agent activity, log-only

#### What the model sees

Nothing. An external agent's transcript, tool activity, permission outcomes, and compaction notices are recorded as log-only `external/*` session events (`ignorable: true`) for replay projection; none of them is woven into a DSH parent session's request context, prompt, or tool schema.

#### Token effect

Zero direct token effect: this registry and the log-only activity it routes add no request tokens to any DSH session.

#### KV Cache effect

No effect: the events are appended outside any model request and share no request prefix with one, so nothing this package records can invalidate or reshape KV-cache reuse.

## Known Limitations and Deferred Work

- **No streaming durability guarantee** — live transcript deltas ride `streamDelta` on the live frame path only and are never written to the durable log; replay reconstructs committed `external/*` units, not the frame deltas.
- **Permission semantics are provider-agnostic and fail closed** — until the ask-user permission bridge lands, `requestPermission` rejects with `PERMISSION_UNWIRED`; the eventual decisions apply per-ask without auditing against an open DSH turn (Phase 1 has no native `approval/asked` pair).
- **Durable and live bridge wiring is host-owned** — `appendEvent` writes only when a live session is registered, and the frame channel and ask-user wiring are responsibilities of later host packages, not this Service Definition.
- **No Config here** — provider configuration (command, roster, disposal grace) is validated by each provider package; this seam passes no tunables through.
