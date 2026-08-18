# @deepseek-ai/dsh-external-permission

English | [中文](README.zh.md)

Host-side permission bridge for external agent sessions ([`external-session`](../../external/external-session/README.md)). This function plugin registers the permission channel on `ctx.externalSessions` so that each external agent's [`ExternalPermissionAsk`](../../external/external-session/README.md) reaches a human through the [`ctx.userQuestions`](../user-questions/README.md) channel, and the human's choice resolves to an [`ExternalPermissionDecision`](../../external/external-session/README.md). It is the host responsibility that turns the Service Definition's default fail-closed `PERMISSION_UNWIRED` throw into a real human decision.

## Channel

Loading the plugin registers the permission answerer for the lifetime of its fibre. Each ask becomes one user question whose options are the ask's offered choices; the returned decision applies back to the provider's ask. Disposing the fibre (HMR) unregisters the channel and restores the fail-closed default.

### Decision mapping

The ask's first option resolves `allowed`, the second `rejected`; any other selection, an empty selection (a dismissed question), or the bounded `timeoutMs` elapsing with no answer resolves `cancelled`. With no user-questions provider registered the ask cannot be answered, so the request rejects loud (`PERMISSION_UNANSWERED`) rather than guessing.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `300000` | Bounded wall-clock budget for one ask before it resolves `cancelled`. Must be a positive safe integer no greater than `MAX_TIMER_DELAY_MS`; misconfiguration fails loud at load. |

## Audit note

Phase 1 has no `approval/asked` / `approval/decided` pair: an external session has no open DSH turn, so the decision applies per-ask without auditing against one. A later phase supersedes this bridge with the native approval seam. See [the external interactive agent sessions spec note](../../../.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md).

## Model Experience

None, as this bridge adds no request-context tokens to any DSH session; the external agent it serves is driven outside the parent's agent loop.

#### KV Cache effect

None; the bridge appends nothing to any request prefix.

## Known Limitations and Deferred Work

- **Human-answerer required** — with no `ctx.userQuestions` provider registered the ask fails loud (`PERMISSION_UNANSWERED`); the bridge cannot make a decision without a human.
- **Phase 1 supersession** — the permission apply path is the ask-user channel with no open DSH turn; a later phase replaces it with a native approval seam.
