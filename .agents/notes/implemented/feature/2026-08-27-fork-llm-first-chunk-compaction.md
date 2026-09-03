# Agent Note: Compact the context on a first-chunk idle timeout, then follow up

Status: implemented

English | [中文](2026-08-27-fork-llm-first-chunk-compaction.zh.md)

## Problem

In long live sessions the provider occasionally stalls on the first LLM chunk: nothing arrives within the first-result window, so `fork-llm-first-chunk-timeout` terminates the stream with a `TIMEOUT` failure and the turn ends. Empirically the stall tracks a very large context, and manually compacting before submitting `continue` resumes useful work. Auto-compaction only fires its own triggers (`pressure` at step boundaries, `context-overflow` on a provider-confirmed overflow), so it never reacts to a first-chunk stall. Repeating the failed provider request is unsafe because its step can describe work from far earlier in a long-running session; recovery needs a new turn from the compacted current surface.

## Decision

Extend the opt-in `fork-llm-first-chunk-timeout` plugin so its first-read timeout emits a distinct `FIRST_CHUNK_TIMEOUT` failure code, and add a companion `agent/request-error` listener (registered with `prepend` so it runs before `dsh-llm-retry`). On a `FIRST_CHUNK_TIMEOUT` failure it forces one compaction through the `compaction` service (`compactIfNeeded(agent, 'context-overflow', signal)`). Durable progress stages a plugin-authored message containing exactly `continue`, and the listener returns no retry action. The failed request therefore ends with its original timeout; its `idle` status transition then inserts the staged message through `agent.followup()` and wakes a new turn from the replacement surface. Inserting the follow-up inside the failing driver would leave it queued after that driver exits. Fast backoff is skipped because it cannot fix a stalled first chunk; the forced `context-overflow` path reduces context even below the normal pressure threshold.

The recovery is bounded by `maxFirstChunkCompactionRetries` (default `100`) across one continuous agent activity. Each successful compaction follow-up opens a new numbered turn, so counting by the failed `turn`/`step` would reset the limit and permit an unbounded chain. Reaching the ceiling still vetoes the waterfall so the original `FIRST_CHUNK_TIMEOUT` ends that turn without another continuation. A compaction error or a result without durable progress delegates to downstream retry/cooldown policy; when no downstream policy claims the failure, the original timeout ends the turn. If no `compaction` engine is present the listener delegates through `next()`, preserving the plugin's original standalone behavior. Per-agent bookkeeping is dropped when the agent becomes idle.

## Alternatives considered

**Letting `dsh-llm-retry` fast-retry `FIRST_CHUNK_TIMEOUT` first.** Rejected: repeated fast retries do not shrink the oversized context that causes the stall, so the fork compacts immediately on the first timeout rather than exhausting the retry budget first.

**Reusing the compaction-basic `context-overflow` handler only.** It is gated on the provider's overflow code and on `maxOverflowRetries`; the first-chunk stall is not an overflow signal, so the fork needs its own trigger.

**Retrying the same provider request after compaction.** Rejected because the request belongs to the failed step and can represent work that the agent completed many turns earlier. A durable `continue` follow-up reproduces the proven manual recovery flow against current compacted history.

## Consequences

A first-chunk idle timeout now triggers one forced compaction, closes the failed turn, and queues a durable plugin-authored `continue` message for a new turn. The plugin adds no prompt section or tool schema, but successful recovery intentionally changes model-visible history and issues a new request. Package tests prove exact follow-up content and provenance, the real agent driver's error-to-idle wake path, absence of a same-request retry, cross-turn ceiling enforcement, downstream fallback when compaction makes no progress, delegation for other codes, absence of a compaction engine, aborted signals, and throw-with/without durable progress; the `fork-base` bundle wiring is asserted by its own spec.
