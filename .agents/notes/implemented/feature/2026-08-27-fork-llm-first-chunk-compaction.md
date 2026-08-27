# Agent Note: Compact the context on a first-chunk idle timeout, then retry

Status: implemented

English | [中文](2026-08-27-fork-llm-first-chunk-compaction.zh.md)

## Problem

In long live sessions the provider occasionally stalls on the first LLM chunk: nothing arrives within the first-result window, so `fork-llm-first-chunk-timeout` terminates the stream with a `TIMEOUT` failure and the turn ends. Empirically the stall tracks a very large context, and forcing a compaction lets the same request succeed on retry. Auto-compaction only fires its own triggers (`pressure` at step boundaries, `context-overflow` on a provider-confirmed overflow), so it never reacts to a first-chunk stall. The fork wanted: on a first-chunk idle timeout, compact once and continue the turn from the compacted surface, without burning intermediate fast retries that cannot help.

## Decision

Extend the opt-in `fork-llm-first-chunk-timeout` plugin so its first-read timeout emits a distinct `FIRST_CHUNK_TIMEOUT` failure code, and add a companion `agent/request-error` listener (registered with `prepend` so it runs before `dsh-llm-retry`). On a `FIRST_CHUNK_TIMEOUT` failure it forces one compaction through the `compaction` service (`compactIfNeeded(agent, 'context-overflow', signal)`), then returns `{ kind: 'retry' }` so the agent loop re-runs the same request from the replacement surface. Fast backoff is skipped because it cannot fix a stalled first chunk; the forced `context-overflow` path reduces context even below the normal pressure threshold.

The recovery is bounded by a new `maxFirstChunkCompactionRetries` config (default `3`) per failing `turn`/`step`/`provider`. When the same step keeps timing out across the ceiling, or compaction makes no durable progress (no compactable range, or it errored without advancing the surface generation), the listener vetoes the waterfall (returns without `next()`) so the original `FIRST_CHUNK_TIMEOUT` error ends the turn promptly instead of spinning on retries. If no `compaction` engine is present the listener delegates through `next()`, preserving the plugin's original standalone behavior. Per-agent bookkeeping is dropped when the agent turns idle.

## Alternatives considered

**Letting `dsh-llm-retry` fast-retry `FIRST_CHUNK_TIMEOUT` first.** Rejected: repeated fast retries do not shrink the oversized context that causes the stall, so the fork compacts immediately on the first timeout rather than exhausting the retry budget first.

**Reusing the compaction-basic `context-overflow` handler only.** It is gated on the provider's overflow code and on `maxOverflowRetries`; the first-chunk stall is not an overflow signal, so the fork needs its own trigger.

## Consequences

A first-chunk idle timeout now triggers one forced compaction and a retry of the same step; the turn completes normally once the compacted request streams, and ends with the `FIRST_CHUNK_TIMEOUT` error if compaction can no longer help. The plugin adds no prompt or tool schema; compaction is entirely the compaction service's durable surface work. Package tests prove retry, veto-on-no-progress, veto-on-ceiling, delegation for other codes, absence of a compaction engine, aborted signals, throw-with/without durable progress, and 100% per-file coverage; the `fork-base` bundle wiring is asserted by its own spec.
