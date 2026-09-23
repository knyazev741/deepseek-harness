# Agent Note: Require assistant progress between automatic compactions

Status: implemented

English | [中文](2026-09-23-no-consecutive-auto-compaction.zh.md)

## Problem

A first-chunk timeout can indicate provider overload rather than excessive context. Repeated forced compaction then spends additional requests summarizing an existing checkpoint without advancing the task. Summarizer retries and cooldown waits can keep one compaction open for many minutes; its opening and closing events alone do not reveal individual attempt durations.

## Decision

The basic backend permits an automatic compaction only when no earlier compaction started, or a newer committed `assistant/message` exists. The existing durable entry-state fold enforces this condition across new turns, plugin continuations, failed requests, and session restores. A failed or cancelled compaction also consumes this opportunity. The automatic region executor checks the condition before appending its opening marker, so direct calls cannot bypass it.

Pressure compaction performs one bounded pass and returns to the model even if pressure remains above threshold. The legacy `compactionRetries` setting remains accepted but cannot authorize consecutive automatic passes. Explicit `/compact` maintenance retains its bounded multi-pass behavior because the user requested that operation directly.

The [first-chunk recovery](../feature/2026-08-27-fork-llm-first-chunk-compaction.md) still compacts once and follows up after durable progress. When the backend declines another compaction, the timeout delegates to normal retries and cooldown. Reaching the first-chunk plugin's own compaction ceiling also delegates instead of vetoing recovery. The [half-window pressure policy](2026-09-08-half-window-and-forced-timeout-compaction.md) remains unchanged; these earlier decisions are only partially superseded.

## Alternatives considered

**Set the compaction retry count to one.** A per-turn or per-process counter resets during continuation or restart and leaves other automatic entry paths unprotected.

**Reset on any new message or turn.** Plugin-generated `continue`, user retries, and failed assistant attempts do not establish model progress and can recreate the same loop.

**Stop retrying after refusing compaction.** This loses the original availability requirement. The original provider failure must remain eligible for the ordinary retry and cooldown chain.

## Consequences

Automatic compaction cannot repeatedly rewrite the same checkpoint without an intervening assistant response. A still-oversized request may need explicit manual compaction, rather than silently performing several automatic passes. Provider retries inside a single compaction remain cancellable and unbounded after cooldown; this change does not impose a total compaction deadline.

Regression coverage checks pressure and forced overflow, direct region execution, restored sessions, failed compactions, continuation messages, and re-enabling after a committed response. The headless recorded-session scenario exercises one compaction followed by twenty first-chunk retries, cooldown, and a successful answer without another compaction.
