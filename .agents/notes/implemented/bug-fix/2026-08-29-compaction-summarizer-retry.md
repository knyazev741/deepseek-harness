# Agent Note: Compaction summarizer retries and agent-scoped recovery

Status: implemented

English | [中文](2026-08-29-compaction-summarizer-retry.zh.md)

## Problem

The basic compaction backend invokes the LLM seam directly for its auxiliary summarization call, while `dsh-llm-retry` handles the loop's `agent/request-error` extension point. A summarization failure therefore does not enter the normal agent retry path. In the Web composition, compaction is mounted inside the isolated agent-preset realm, while first-chunk recovery runs in the host realm and cannot find that service through `ctx.get('compaction')`. A transient upstream overload could consequently end compaction before the recovery follow-up was staged.

## Decision

`compaction-basic` resolves the selected provider route's captured `ResolvedRetryPolicy` and applies it to every auxiliary stream attempt. A normal route uses its fast backoff for `maxRetries`; after that finite budget, `summarizerCooldownMs` (default `600000`) waits and retries eligible transient failures without resetting the fast counter. An always route uses local backoff without a cap. Valid provider `Retry-After` values within the route limit are honored; an over-cap value fails a normal route and falls back to local delay for an always route. Cancellation and non-retryable failures remain authoritative, and each attempt builds a fresh block assembler.

The first-chunk recovery listener resolves `ctx.agentPresets.serviceFor(agent, 'compaction')` before falling back to the host compaction service. It stages the plugin-authored `continue` follow-up only after durable compaction progress, so a `FIRST_CHUNK_TIMEOUT` remains in the recovery operation while the summarizer retries or waits for cooldown.

## Alternatives considered

- **Reuse `dsh-llm-retry` for summarization** — rejected because that listener is attached to the agent request-error waterfall and direct compaction may run without an open turn or step.
- **Treat a transient summarization failure as final and wait for a user continuation** — rejected because first-chunk recovery then cannot make progress during a temporary upstream outage.
- **Move isolated compaction into the host realm** — rejected because the agent preset owns the service instance and separate agents may have separate composition and policy.
- **Reset the fast retry budget after every cooldown** — rejected because an indefinitely unavailable provider would receive unbounded fast bursts; cooldown retries continue without multiplying the fast burst budget.

## Consequences

Transient summarizer failures can keep an active compaction operation alive through provider-policy retries and the configured cooldown, allowing first-chunk recovery to resume only after a durable replacement exists. The cooldown limits waiting time between post-budget attempts, not the number of attempts. Direct summarizer retries are operational logs rather than `llm/retry` events because they can run outside a turn/step. The optional agent-presets peer dependency lets the recovery plugin retain its host-only composition behavior.

## Testing

Focused tests cover route-policy fast retries, cooldown retries, provider delay handling, cancellation, coded middleware failures, configuration validation, and isolated agent-preset compaction lookup. The assembled headless compaction snapshot injects two transient summarizer failures and verifies that durable compaction and the continuation still complete. Focused coverage is 100% for the changed summarizer/config and recovery modules.
