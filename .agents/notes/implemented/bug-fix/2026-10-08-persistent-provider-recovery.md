# Agent Note: Persistent provider recovery after fast retries

Status: implemented

English | [中文](2026-10-08-persistent-provider-recovery.zh.md)

## Problem

The fork promises recovery through long provider outages, but empty responses, closed streams, oversized Retry-After values, and exhausted compaction ceilings could terminate a task. Successful cooldown recovery was invisible in the session log, leaving the client on an exhausted fast-retry counter.

## Decision

The Gonka route selects the provider-owned always policy: every normalized model failure retries with jittered exponential backoff from 500 ms to a 10-second cap. Summary requests use the same policy. Normal-mode routes retain the fork cooldown after their bounded budget, with a 10-second deployment delay and longer provider delays honored. Other request recovery listeners run first. Existing retry events retain a stable policy-chain identity and contiguous attempts.

First-chunk and overflow compaction ceilings delegate to retry policy. A downstream retry permits another bounded compaction batch. Gonka model policies enable persistent summary recovery; empty summaries and failures outside the provider's fast list also wait and retry. Summary requests retain their own cancellation and operational logging because they may run without an open turn or step.

This partially supersedes the stopping conditions in [cooldown recovery](../feature/2026-08-24-fork-llm-rate-limit-cooldown.md), [first-chunk recovery](../feature/2026-08-27-fork-llm-first-chunk-compaction.md), and [summary retries](2026-08-29-compaction-summarizer-retry.md). Their service ownership, durable-progress requirements, and continuation rationale remain applicable.

## Alternatives considered

Increasing a finite attempt count moves the same eventual stop. Restarting the fast burst after every cooldown increases provider load during outages. Retrying every operation in the agent loop would also repeat local mutations and bypass the request and compaction recovery owners. The fork therefore extends those existing recovery points.

## Consequences

Transient failures no longer exhaust the fork's attempt budget. Permanent provider errors can wait indefinitely until corrected or cancelled; retrying cannot guarantee a successful provider response. Cancellation and plugin disposal stop new attempts. In-memory waits are not a restart scheduler, and storage, configuration, process crashes, and errors outside these recovery points remain distinct failures.

## Testing

Real agent-loop cases traverse 45 failures for each of twelve codes before success, plus pre-budget Retry-After and unsupported-code cases. The keyless persistent-provider snapshot reopens a log with 27 failures under the always policy; the fork-cooldown snapshot also covers the normal-mode fallback. Compaction tests cover renewed batches, summary recovery, and cancellation.
