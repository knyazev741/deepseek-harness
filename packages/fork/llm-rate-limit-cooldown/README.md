---
description: "Fork distribution package ownership and configuration."
kind: "package-reference"
---

# @knyazevai/dsh-fork-llm-rate-limit-cooldown

English | [中文](README.zh.md)

## Summary

Fork-owned LLM plugin that keeps a provider-limited request alive after `dsh-llm-retry`'s bounded budget is exhausted. It waits a long cooldown and returns one retry action so the agent loop re-attempts the same request, instead of letting a persistent `429` (rate limit) or upstream `5xx` (`502`/`503`, provider down) that outlasts fast backoff end the turn.

## Table of Contents

- [Composition](#composition)
- [Escalation after the bounded budget](#escalation-after-the-bounded-budget)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="composition"></a>
## Composition

```yaml
- id: fork-llm-rate-limit-cooldown
  name: '@knyazevai/dsh-fork-llm-rate-limit-cooldown'
  config:
    cooldownMs: 600000
```

The plugin requires `agents` and listens on the `agent/request-error` waterfall. It is opt-in and is not mounted by an ordinary profile; the Host fork overlay mounts it together with `dsh-llm-retry`.

<a id="escalation-after-the-bounded-budget"></a>
## Escalation after the bounded budget

`dsh-llm-retry` owns fast backoff. This plugin extends only a provider's `normal` policy: after its fast budget, an unsupported fast-retry code, or an oversized `Retry-After`, matching failures receive an unlimited sequence of cooldown attempts. `retryableCodes: ['*']`, selected by `fork-base`, includes every normalized provider failure. A missing policy and `always` policy remain owned by downstream recovery.

Other recovery listeners, including compaction, run before a cooldown is scheduled. Each wait lasts at least `cooldownMs` (default `600000`, ten minutes), or longer when the provider requests it. Long waits are split at Node's timer limit. Turn cancellation and plugin disposal cancel the wait and prevent another request.

Each wait appends `llm/retry` with `mode: always`, followed by `llm/retry-started` only after the delay completes. A separate policy chain starts at one and keeps its retry identity, so clients show the current wait instead of a stale exhausted fast-retry counter. The same failed request is retried until it succeeds or is cancelled.

<a id="model-experience"></a>
## Model Experience

### Retry recovery

#### What the model sees

The plugin adds no prompt, tool schema, or other model-visible text. When it claims an exhausted limited request, the model simply sees the request eventually succeed after the cooldown, or fail terminally if the turn is cancelled. Recovery records `llm/retry` and `llm/retry-started` events without changing the model-visible context.

#### Token effect

Zero. A claimed retry performs one additional model request after the cooldown; a delegated failure performs none from this plugin.

#### KV Cache effect

The retry preserves the request prefix unless another composed recovery plugin changes it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The long cooldown holds the turn open while waiting; a user `cancel` aborts the wait and settles the failure terminally. There is no Web surface that renders the cooldown countdown; a later client change could project it from the retry chain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintenance context</summary>

Retain focused fork tests when adapting this package to upstream APIs. Configuration and behavior are documented above.

</details>
