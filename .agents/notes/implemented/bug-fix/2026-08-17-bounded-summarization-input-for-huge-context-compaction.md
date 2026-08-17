# Agent Note: Bounded summarization input for huge-context compaction

Status: implemented

English | [中文](2026-08-17-bounded-summarization-input-for-huge-context-compaction.zh.md)

## Problem

Compaction replays the shadowed region into the summarization call so the provider's warm prefix cache stays aligned (the [prefix-cache-reuse decision](2026-07-21-compaction-summary-prefix-cache-reuse.md)). On a huge-context model the region is huge: at the default `0.8` pressure threshold of a 400k window the replay can reach ~300k tokens in one request. A slow gateway can take longer to prefill that than the pi-ai adapter's stream idle watchdog allows (default 300s), so the summarization stream dies with `pi-ai stream idle timeout after 300000ms` and compaction fails with "could not produce a useful summary". Reproduced on a 350k-token session routed to `knyazev-ai/deepseek-v4-flash`: `/compact` wrote `compaction/start` and immediately failed the summarization call the same way the conversation's own oversized requests did. Raising the output cap does not help — the failure is input-side prefill, not `max-tokens` truncation.

## Decision

`dsh-compaction-basic` gains a policy field `maxSummarizationInputTokens` (default `131072`; `0` replays the whole region, preserving the old behavior). Range selection bounds the head-anchored span to the **shortest prefix whose priced tokens exceed the budget**, then extends the end cut forward until it is tool-pair balanced. Choosing the crossing prefix — never stopping short of it — guarantees the span is never a pathologically small slice that would fail the "summary must be smaller than the shadowed content" check on its own.

Bounded selection applies everywhere a range is chosen:

- Automatic step-pressure and overflow passes select one bounded chunk per attempt, so a huge region converges over several small fast summarization calls instead of one oversized prefill.
- `compactNow()` loops bounded passes under a single `runMaintenance` reservation until no range remains or the selected span consists entirely of prior compaction checkpoints (the terminal pass would otherwise re-compact the lone checkpoint and fail the shrink check). Each pass remains its own bracket transaction with its own durability flush, and the active-compaction lock is asserted before every pass.

The budget is soft by design: a tool-pair boundary may extend one pair past it, and an oversized single node always ships alone.

## Consequences

- Every summarization prefill is bounded (~128k tokens by default), so compaction works on huge-context sessions whose gateways cannot prefill the whole region in time.
- `/compact` on a huge session now completes the whole surface in one invocation (several bounded passes) instead of failing or requiring repeated runs.
- The byte-for-byte prefix claim of the [prefix-cache-reuse decision](2026-07-21-compaction-summary-prefix-cache-reuse.md) holds on the replayed span; only the span length changes.
- Per-pass checkpoints merge prior checkpoints per the existing compaction instruction, so chunked passes do not accumulate redundant summaries.

## Alternatives considered

- **Raise the provider stream idle timeout** (`streamIdleTimeoutMs`) — a configuration-level band-aid that keeps paying minutes of prefill per compaction; retained only as a complementary knob for operators, not the fix.
- **Cap the summarization output** (`maxTokens`) — treats the wrong failure mode; the observed error is input-side prefill timeout, not output truncation.
- **Summarize only a recent window of the region** — loses the head of the conversation, which the whole region's checkpoint must preserve.
