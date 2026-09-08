# @knyazevai/dsh-fork-llm-rate-limit-cooldown

English | [中文](README.zh.md)

Fork-owned LLM plugin that keeps a provider-limited request alive after `dsh-llm-retry`'s bounded budget is exhausted. It waits a long cooldown and returns one retry action so the agent loop re-attempts the same request, instead of letting a persistent `429` (rate limit) or upstream `5xx` (`502`/`503`, provider down) that outlasts fast backoff end the turn.

## Composition

```yaml
- id: fork-llm-rate-limit-cooldown
  name: '@knyazevai/dsh-fork-llm-rate-limit-cooldown'
  config:
    cooldownMs: 600000
```

The plugin requires `agents` and listens on the `agent/request-error` waterfall. It is opt-in and is not mounted by an ordinary profile; the Host fork overlay mounts it together with `dsh-llm-retry`.

## Escalation after the bounded budget

`dsh-llm-retry` owns fast exponential backoff for transient failures up to each provider's `retryPolicy.maxRetries` and, for `mode: always`, retries every failure unboundedly. This plugin extends the bounded (`mode: normal`) path only:

- It claims a failure only when `failure.code` is in `retryableCodes` (default `['RATE_LIMIT', 'SERVER', 'QUOTA', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR']`: `RATE_LIMIT` is HTTP `429`, `SERVER` is an upstream 5xx such as `502`/`503`, `QUOTA` is capacity-quota exhaustion, `TIMEOUT` is a request timeout, `TRANSPORT` is a stream/connection truncation, and `PI_AI_ERROR` is the pi-ai provider catch-all) and the request's durable `llm/retry` chain for that `turn`/`step`/`provider` has reached the provider's `maxRetries`.
- Anything else — a different code, an unbounded/absent policy, or a budget not yet exhausted — is delegated through `next()`, leaving ownership with `dsh-llm-retry` or a later listener.

The claim waits `cooldownMs` (default `600000` = 10 minutes, non-zero and no greater than Node's reliable timer maximum `2147483647`) on a delay cancellable by the turn `signal` and by plugin disposal, then returns `{ kind: 'retry' }`. The loop then re-runs the same request; if it is limited again, the plugin claims again and waits again — so a persistent `429`, upstream `5xx`, quota, timeout, or transport fall is retried roughly every `cooldownMs`.

The default code set is keyed to live-session evidence: these are the transient provider and upstream falls observed on real `knyazev-ai` sessions. `PI_AI_ERROR` is included by default despite also carrying a non-transient module-resolution environment error in rare cases, per the deployment's preference for aggressive provider-outage coverage; drop it from `retryableCodes` if you prefer to surface those failures terminally instead of retrying them.

Because the claim is a pure function of the durable retry count, the plugin is order-independent on the waterfall: whether it or `dsh-llm-retry` fires first, only the exhausted case escalates.

## Model Experience

### What the model sees

The plugin adds no prompt, tool schema, or other model-visible text. When it claims an exhausted limited request, the model simply sees the request eventually succeed after the cooldown, or fail terminally if the turn is cancelled. No durable session event is appended.

### Token effect

Zero. A claimed retry performs one additional model request after the cooldown; a delegated failure performs none from this plugin.

## Known Limitations and Deferred Work

- The long cooldown holds the turn open while waiting; a user `cancel` aborts the wait and settles the failure terminally. There is no Web surface that renders the cooldown countdown; a later client change could project it from the retry chain.
