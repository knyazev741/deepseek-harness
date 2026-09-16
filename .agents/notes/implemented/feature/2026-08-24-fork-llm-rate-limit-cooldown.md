# Agent Note: Long-cooldown rate-limit retry after the bounded budget

Status: implemented

English | [中文](2026-08-24-fork-llm-rate-limit-cooldown.zh.md)

## Problem

The `knyazev-ai` provider returns `429` persistently during an outage. `dsh-llm-retry` retries with fast exponential backoff up to the provider's `retryPolicy.maxRetries` (20 in the Host `fork-base` overlay); when the budget is exhausted the failure is terminal and ends the turn. The fork wanted an automatic post-budget retry every few minutes so the turn succeeds without manual intervention, while keeping the change in plugins and never touching upstream `agent-loop` or `llm` code.

## Decision

Add an opt-in fork plugin, `fork-llm-rate-limit-cooldown`, on the documented `agent/request-error` waterfall. It is order-independent: it claims a failure only when `failure.code` is in `retryableCodes` (default `['RATE_LIMIT', 'SERVER', 'QUOTA', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR']`: `RATE_LIMIT` is HTTP `429`, `SERVER` is an upstream 5xx such as `502`/`503`, `TRANSPORT` is a stream/connection truncation, and `PI_AI_ERROR` is the pi-ai catch-all) and the request's durable `llm/retry` chain for that `turn`/`step`/`provider` has already reached the provider's `maxRetries`; everything else delegates through `next()` to `dsh-llm-retry` or a later listener. The claim waits `cooldownMs` (default `600000` = 10 minutes) on a delay cancellable by the turn signal and by plugin disposal, then returns `{ kind: 'retry' }` so the loop re-runs the same request.

Because the claim is a pure function of the persistent retry count, listener order on the waterfall does not matter; the Host `fork-base` patch inserts the row after `dsh-llm-retry` with `cooldownMs: 600000`, so a persistent `429`, upstream `5xx`, quota, timeout, or transport fall is retried roughly every ten minutes until it succeeds or the user cancels.

The default code set is evidence-based: scanning recent live `knyazev-ai` sessions in `~/.dsh/sessions` surfaced these transient provider and upstream falls (`RATE_LIMIT`, `SERVER`/502, `QUOTA`, `TIMEOUT`, `TRANSPORT`, plus the `PI_AI_ERROR` catch-all). `PI_AI_ERROR` is included by default though it can also carry a non-transient `Cannot find module` environment error, per deployment preference for covering provider outages; it can be removed from `retryableCodes` to surface those as terminal instead.

## Alternatives considered

**Modifying upstream `agent-loop` or `llm-retry`.** Rejected: the fork keeps behavior changes in plugins, and the loop already exposes the `retry` action path needed.

**Reconfiguring the provider to `retryPolicy.mode: always`.** Rejected: unbounded retries restart immediately with fast backoff, which would hammer a rate-limited provider rather than waiting a long cooldown.

## Consequences

A persistent `429`, upstream `5xx`, quota, timeout, transport, or pi-ai catch-all keeps the turn alive and is retried roughly every `cooldownMs` until success or cancellation. The plugin adds no prompt, tool schema, or durable session event; successful requests have zero token effect. Package tests prove escalation, delegation, cancellation, and disposal, with 100% per-file coverage; the Host `fork-base` bundle wiring is asserted by its own spec.
