# Agent Note: First-chunk idle timeout and pressure-aware compaction

Status: implemented

English | [中文](2026-08-18-first-chunk-idle-timeout-pressure-compaction.zh.md)

## Problem

A large model prompt can take longer to prefill than the stream idle watchdog allows. The watchdog, armed with one `streamIdleTimeoutMs` budget (default five minutes) from the moment a request starts, aborted a ~216k-token prompt on every attempt after ~300s before the provider delivered its first chunk. The retry policy re-sent the identical payload, so each attempt failed identically; the user watched several consecutive timeouts and had to run `/compact` by hand. Automatic compaction never fired because its `thresholdRatio` (0.8 of the advertised 400k window, ~320k tokens) sits far above the ~216k tokens at which this provider stalls, and the GUI's context meter showed 54% — reading as healthy — while the turn was effectively stuck.

## Decision

The wait for a stream's first value is no longer priced by the inter-chunk idle budget. `dsh-timeout`'s `idleWatchdog` now takes two budgets and two codes: `firstChunkMs`/`firstChunkCode` apply until the first `next()` resolves, and `idleMs`/`idleCode` apply to every later demand. Both LLM adapters (`dsh-llm-pi-ai` and `dsh-llm-deepseek`) expose a `firstChunkIdleTimeoutMs` profile field (default fifteen minutes) beside the existing `streamIdleTimeoutMs`, and map a first-chunk expiry to the new `FIRST_CHUNK_TIMEOUT` failure code while an inter-chunk stall keeps `TIMEOUT`. `FIRST_CHUNK_TIMEOUT` is in the default retryable set.

Recovery is now size-aware. `dsh-llm-retry` stays registered first in the `agent/request-error` waterfall but, for `FIRST_CHUNK_TIMEOUT` and `TIMEOUT`, consults downstream before computing its own backoff: it honors a downstream `{ kind: 'retry' }` verbatim (no `llm/retry` event, matching the overflow path) and falls back to its normal bounded retry when downstream does not recover. `dsh-compaction-basic` handles `FIRST_CHUNK_TIMEOUT` and `TIMEOUT` in the same recovery body as `CONTEXT_WINDOW_EXCEEDED`, but gates them on a new `idleTimeoutPressureRatio` (default 0.5): at or above half the routed model's window it compacts and returns retry; below, or with no capacity to gate on, it delegates so the retry policy retries the same payload. `TIMEOUT` covers the inter-chunk stall and the SDK-level request timeout (no response within the total budget) — both are also "prompt too large to prefill or stream" symptoms, so they share the first-chunk pressure gate rather than blind same-payload retries.

The web GUI makes the condition visible. The model-retry node appends a `/compact` hint when the failed attempt carries `FIRST_CHUNK_TIMEOUT` or `TIMEOUT` and the `contextPressure` projection is at least half of the route capacity, and `ContextMeter` flags occupancy at 50% and above with a warning tint and assistive-technology label.

## Alternatives considered

**Raise `streamIdleTimeoutMs` globally.** Rejected: it lengthens genuine inter-chunk stalls without reducing context, and does not produce compaction when the prompt is the problem.

**Make `FIRST_CHUNK_TIMEOUT` non-retryable and rely on compaction alone.** Rejected: a low-pressure first-chunk timeout is a transient stall worth retrying, and making compaction the only actor would drop that retry.

**Reorder the bundle so compaction runs before llm-retry.** Rejected: it risks every other listener on the shared waterfall; delegation keeps llm-retry's registration position while giving compaction the first look for this code only.

**Scale the first-chunk budget by estimated prompt tokens.** Rejected: a fixed generous default plus a per-provider override covers the failure without adding estimator coupling to the adapter and a new config surface.

**GUI hint without the backend change.** Rejected: visibility alone still leaves the loop blindly re-sending the oversized payload.

## Consequences

A provider legitimately prefilling a large prompt is no longer killed by the inter-chunk idle budget, and a prompt too large to prefill now compacts before retrying instead of retrying in place. The `FIRST_CHUNK_TIMEOUT` code is durable in session logs (`llm/retry` events carry it), so replay and the GUI distinguish the two timeout causes. Two new tunables exist — `firstChunkIdleTimeoutMs` (per provider, default 900s) and `idleTimeoutPressureRatio` (per model policy, default 0.5) — and remain deployment-configurable rather than hardcoded. The first-chunk and inter-chunk budgets are still one abort-signal watchdog, so caller aborts continue to win over both.

## Related

- [After-call compaction pressure and overflow recovery](../architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) — the recovery body this change extends with the pressure-gated `FIRST_CHUNK_TIMEOUT` trigger.
- [Routed model context and compaction policy](../architecture/2026-07-20-routed-model-context-and-compaction-policy.md) — the `thresholdRatio`/per-model policy resolution that `idleTimeoutPressureRatio` joins.
- [Classify pi-ai transport truncations from flattened message text](2026-07-22-pi-ai-transport-truncation-classification.md) — the neighboring pi-ai failure-classification work that first mapped recoverable drop wordings to retryable codes.
