# @deepseek-ai/dsh-user-approval

English | [中文](README.zh.md)

Channel-neutral one-shot approval seam. `ctx.approval.request(req)` returns `allowed-once`, `rejected`, `cancelled`, or `unavailable`; missing or failing answerers fail closed, and a grant applies only to the requested action. Exact event signatures live in the generated region of [approval.md](../../../docs/subsystems/approval.md#cordis-surface).

Each request must belong to an open agent turn. The service appends a paired `approval/asked` and `approval/decided` audit record, while the model sees only the resulting logged tool outcome. An aborted request resolves `cancelled`; an audit append that fails before commit rejects rather than returning an unlogged decision.

External providers use `ctx.approval.requestExternal(req)` with an external principal and branded tool-call id. It appends paired `external/approval-asked` and `external/approval-decided` records without fabricating a native Agent or turn. A missing answerer, disposed principal, aborted request, or malformed decision fails closed as `unavailable`/`cancelled`; the exact principal, owning Session id, and call id must match on both records, and no decision is accepted after `external/session-ended`.

Answerers are `approval/request` waterfall listeners. Return an outcome to answer for an owned agent or call `next()` to delegate. Agent-scoped listeners receive only that agent's requests; compose one terminal answerer per deployment because sibling listener order is not a policy priority mechanism. The ACP automation bridge supplies one-shot machine decisions for sessions it owns.

`ApprovalPolicy` is `'ask'` or `'never'`. The effective value is the last `approval/policy` event, falling back to config; `setApprovalPolicy()` is the write path. `'never'` rejects before interactive dispatch. Both policies contribute their complete current meaning to the cache-safe runtime-context snapshot.

The tools pipeline routes `ask` decisions through this seam and fails closed when it is absent; the sandboxed bash tool also uses it for escalated retries. The ACP automation bridge answers calls for its own agents through the client's machine policy. Audit events remain log-only, so the model sees only the asking consumer's result. See the [approval-seam Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.md) and [sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md).

## Model Experience

### Current approval policy context

#### What the model sees

The first request and each effective policy change append a full runtime-context snapshot after retained history. Under `ask`, the approval contribution states that configured answerers may be consulted and absence fails closed. Under `never`, it states the deterministic rejection and non-escalation consequence. Unchanged requests retain the earlier snapshot without adding another message.

##### Ask-policy contribution

```markdown
Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.
```

##### Never-policy contribution

```markdown
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
```

#### Token effect

One concise context message on the first request and on an effective change; unchanged requests add no duplicate policy tokens.

#### KV Cache effect

Append-only after retained history. An `ask`/`never` switch preserves the stable system and conversation prefix instead of rewriting the first wire message.

### Tool outcome

#### What the model sees

`approval/asked` and `approval/decided` are log-only. The model sees only the asking consumer's eventual allowed, rejected, cancelled, or unavailable tool outcome; the human permission UI is not context.

#### Token effect

Zero duplicate audit tokens. A rejection may replace a normal tool result with a small retained error, while an allowance leaves the consumer's ordinary result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Requests are valid only inside an open turn** — an idle or between-turn caller throws before auditing; a durable out-of-turn approval workflow is deferred.
- **Only one-shot grants exist** — the outcome vocabulary has `allowed-once` but no `allow-always`, remembered rule, revocation, or grant store; session policy is only `ask` / `never`.
- **The request carries no tool arguments** — an answerer sees the tool name, reason, and optional call id; the ACP machine channel requires a call id and delegates requests without one.
- **No built-in answerer** — headless or incompletely composed deployments resolve `unavailable` and fail closed; the service itself never prompts a human.
- **External approvals are one-shot and audit-paired** — the external path records only the bounded principal/session/call metadata needed for replay; the invariant binds the session id to the owning Session and rejects decisions after `external/session-ended`; it does not create native turn state or retain a grant. Live request/principal types are server-only `external-types`; wire event data and branded ids remain in `types`.
