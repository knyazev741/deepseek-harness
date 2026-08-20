# @deepseek-ai/dsh-external-session

English | [中文](README.zh.md)

External interactive-agent session Service Definition. Owns the `ctx.externalSessions` service contract ([`ExternalSessionsService`](src/types.ts)): a named-provider registry whose providers drive live sessions on behalf of an external agent process (Codex, Claude Code, an ACP client), plus the per-session bridge handed to a provider at start. As the Service Definition role of the [capability-seam split](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md), it depends only on cordis, the branded-id primitive, the session envelope types, and the harness error base — never on a concrete external agent or its wire protocol. The first provider (`external-session-codex`) and the host bridge driver are separate packages that consume this seam's contracts. The design and phase sequencing live in [the external interactive agent sessions spec note](../../../.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md).

The contract in one line: a registry maps unique provider names (`provider`, also the session mode id) to [`ExternalSessionProvider`](src/types.ts) implementations; `start(request)` resolves the provider, records the session-to-provider route, and hands it a live [`ExternalBridgeContext`](src/types.ts) — `principal` and its durable recorder when a live SessionStore is present, `appendEvent` (log-only session events), `requestPermission` (ask the human), `streamDelta` (live-only deltas), and a `disposal` signal. The recorder accepts one bounded JSON call and one matching result per branded call id, writing `external/tool-call` before `external/tool-result`; it never fabricates a native Agent or turn. `streamDelta` emits the typed `external/session-delta` Cordis event; the service does not import or depend on the host mux. `resume(request, providerThreadId)` is a separate explicit attachment path for a durable provider identity; it never falls back to `start` or creates a replacement thread. Later calls — `prompt`, `interrupt`, `compact`, `setModel`, `dispose` — take only the session id and dispatch to the owning provider. `compact` runs the provider's native context compaction (`/compact` in an external mode maps here); a provider whose native surface lacks the operation rejects loud.

`ExternalProviderThreadId` is the branded opaque value passed to `resume`. `ExternalProviderThreadId(value)` is used only when trusted provider wire output becomes a typed value; `parseExternalProviderThreadId(value)` is used when durable JSON or other untyped input is read. The registry does not persist or render the value and does not infer it from a provider path.

`ExternalSessionStartRequest` accepts optional `sandbox` and `approvalPolicy`; the registry resolves them to `read-only` and `ask` before calling the provider, while `model` and `reasoningEffort` remain provider-facing selections. The registry publishes the provider route and disposal signal before awaiting startup, and rolls both back when startup rejects, so a failed start cannot leave a stale dispatch route. A provider's `setModel` must accept only an id from its advertised `listModels` catalog or document a different authoritative catalog.

The registry is effect-scoped HMR-safe: `registerProvider(provider)` returns the exact Cordis effect disposer. Removing a provider blocks new starts but does not revoke live sessions already returned to their holders.

`start` and `resume` share one in-flight attachment per session id. Concurrent callers therefore receive the same startup result; a rejected operation removes the route and disposal signal and lets a later attempt retry. Providers receive the resolved request only after the route is reserved, so prompt and disposal races remain owned by the same lifecycle.

## Registry

- `listAgents()` — descriptors of every registered provider, in insertion order (`provider`, `label`, `modelDirectory`). The label feeds the mode picker; Chinese product copy lives client-side.
- `registerProvider(provider)` / `getProvider(name)` / `list()` — the registry surface; registration is effect-scoped and emits `external/provider-added` / `external/provider-removed`.
- `modelDirectory` — `'provider'` (native catalog) or `'config'` (validated roster owned by the provider). `listModels(provider)` always dispatches to the named provider, which answers from whichever surface its directory names.

Modes are not presets: choosing one composes the same host process and fixes the driving backend. Session creation with a `mode` is a later host phase; this package pre-receives a reserved [`SessionId`](../../core/session/) at `start` and never invents one.

## Bridge

`start` hands each provider one per-session [`ExternalBridgeContext`](src/types.ts):

- `appendEvent(sessionId, event)` — writes a writer-side event fragment into the durable session log when a live session is registered (log-only); otherwise drops it. Sequencing is stamped by the session, and the event owner's persistence contract supplies its `ignorable` marker.
- `requestPermission(sessionId, ask)` — consults the registered permission channel and fails closed while none is wired (rejects `PERMISSION_UNWIRED`); the ask-user bridge is a host responsibility. `registerPermissionChannel(answerer)` registers the channel, effect-scoped and HMR safe like `registerProvider`: at most one is active, and disposing it restores the fail-closed default.
- `streamDelta(sessionId, turnId, delta)` — emits one `external/session-delta` Cordis event for the host mux, forward-only and never durable.
- `principal` — an external execution identity scoped to the live session. Its recorder validates lossless JSON, enforces the complete-record byte bound, and rejects unmatched or duplicate call/result ids.
- `disposal` — an `AbortSignal` that fires when the session is disposed, so the provider can tear down its process.

Providers should treat `disposal` as cancellation for pending work: approval asks and startup operations must settle without appending decisions after `external/session-ended`.

## Events

Context events (this package): `external/provider-added` and `external/provider-removed` carry the registry↔descriptor transitions; `external/session-delta` carries one transient provider turn delta to the host mux.

The durable `external/*` session-log event vocabulary (session-started, turn-started, message-added, tool-activity, tool-call/result, permission-asked/decided, model-switched, compaction-noticed, turn-ended, session-ended) is merged into the session `SessionEventMap` and projected for replay; this package routes the recorder-owned tool pair and the other events through `appendEvent`.

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
- **Permission semantics are provider-agnostic and fail closed** — until a permission channel is registered via `registerPermissionChannel`, `requestPermission` rejects with `PERMISSION_UNWIRED`; the eventual decisions apply per-ask without auditing against an open DSH turn (Phase 1 has no native `approval/asked` pair).
- **Durable and live bridge wiring remains split by ownership** — `appendEvent` writes only when a live session is registered, while this Service Definition emits `external/session-delta` and the host API projects it as `external/delta` to subscribed mux clients. Ask-user wiring remains host-owned.
- **Resume identity is provider-owned** — the registry stores no thread id and cannot infer one from a path or event; the host reads the opaque durable id and calls explicit `resume` when it materializes a cold session.
- **No Config here** — provider configuration (command, roster, disposal grace) is validated by each provider package; this seam passes no tunables through.
- **Recorder records committed values only** — each call and result is detached through the session JSON boundary and capped at 64 KiB of UTF-8 event data; oversized or non-JSON values fail before the log changes.
