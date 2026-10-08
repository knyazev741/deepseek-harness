# Agent Note: Persistent provider recovery after fast retries

Status: implemented

English | [中文](2026-10-08-persistent-provider-recovery.zh.md)

## Problem

The fork promises recovery through long provider outages, but empty responses, closed streams, oversized Retry-After values, and exhausted compaction ceilings could terminate a task. Successful cooldown recovery was invisible in the session log, leaving the client on an exhausted fast-retry counter.

## Decision

The fork overlay selects every normalized provider failure for unlimited cooldown recovery. Fast retries remain bounded; cooldown begins when that budget is exhausted or cannot handle the failure. Other request recovery listeners run first. Each cancellable wait lasts at least ten minutes in the shipped overlay and honors longer provider delays. The existing retry event protocol records a separate unbounded policy chain with a stable identity and contiguous attempts.

First-chunk and overflow compaction ceilings delegate to retry policy. A downstream retry permits another bounded compaction batch. Gonka model policies enable persistent summary recovery; empty summaries and failures outside the provider's fast list also wait and retry. Summary requests retain their own cancellation and operational logging because they may run without an open turn or step.

This partially supersedes the stopping conditions in [cooldown recovery](../feature/2026-08-24-fork-llm-rate-limit-cooldown.md), [first-chunk recovery](../feature/2026-08-27-fork-llm-first-chunk-compaction.md), and [summary retries](2026-08-29-compaction-summarizer-retry.md). Their service ownership, durable-progress requirements, and continuation rationale remain applicable.

## Alternatives considered

Increasing a finite attempt count moves the same eventual stop. Restarting the fast burst after every cooldown increases provider load during outages. Retrying every operation in the agent loop would also repeat local mutations and bypass the request and compaction recovery owners. The fork therefore extends those existing recovery points.

## Consequences

Transient failures no longer exhaust the fork's attempt budget. Permanent provider errors can wait indefinitely until corrected or cancelled; retrying cannot guarantee a successful provider response. Cancellation and plugin disposal stop new attempts. In-memory waits are not a restart scheduler, and storage, configuration, process crashes, and errors outside these recovery points remain distinct failures.

## Testing

Real agent-loop cases traverse 45 failures for each of twelve codes before success, plus pre-budget Retry-After and unsupported-code cases. The keyless fork-cooldown snapshot reopens the resulting log after twenty fast retries and two cooldown retries. Compaction tests cover renewed batches, summary recovery, and cancellation.
