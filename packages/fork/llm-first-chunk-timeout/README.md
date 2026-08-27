# @deepseek-ai/dsh-fork-llm-first-chunk-timeout

English | [中文](README.zh.md)

Function plugin that bounds the idle wait for the first result of the `llm/stream` waterfall. It is opt-in and is not mounted by an ordinary profile.

## Composition

```yaml
- id: fork-llm-first-chunk-timeout
  name: '@deepseek-ai/dsh-fork-llm-first-chunk-timeout'
  config:
    firstChunkIdleTimeoutMs: 120000
    maxFirstChunkCompactionRetries: 3
```

The plugin requires `llm` and calls the zero-argument continuation exactly once for each waterfall invocation. The frozen request is read without mutation; its caller-owned `signal` remains the provider's cancellation input.

## First-result deadline

`firstChunkIdleTimeoutMs` defaults to `120000` and must be a positive safe integer no greater than Node's reliable timer maximum, `2147483647`. The timer races only the first downstream `iterator.next()` result. A yielded value or normal `done` result clears the timer and forwards the iterator unchanged, so no inter-chunk deadline is imposed.

When the timer wins, the wrapper yields one terminal `finish` chunk with a `FIRST_CHUNK_TIMEOUT` failure and starts downstream `return()` without awaiting it. A caller abort clears this plugin's timer and leaves the provider's cancellation outcome unchanged. A downstream rejection remains the same rejection. Consumer return and plugin disposal clear plugin state and close downstream on a best-effort basis. Consumer `throw(error)` delegates to downstream `throw` when present, preserving its result or rejection; otherwise it closes downstream best-effort and rejects with the caller error.

## First-chunk compaction recovery

On a `FIRST_CHUNK_TIMEOUT` failure the plugin prepends an `agent/request-error` listener that forces one context compaction through the `compaction` service (`context-overflow` trigger), then returns a retry action so the agent loop re-attempts the same request from the replacement surface. Fast `dsh-llm-retry` backoff is skipped because it cannot fix a stalled first chunk. `maxFirstChunkCompactionRetries` (default `3`) bounds compactions per failing request step: when the same step keeps timing out across the ceiling, or compaction makes no durable progress, the listener vetoes the chain so the original `FIRST_CHUNK_TIMEOUT` error ends the turn. Without a `compaction` engine the listener delegates through `next()`, preserving the plugin's standalone behavior.

## Model Experience

### Stream failure

#### What the model sees

The plugin adds no prompt or tool schema. When the first-result deadline wins, the stream terminates with this stable diagnostic and the `FIRST_CHUNK_TIMEOUT` failure code:

##### Timeout diagnostic

```markdown
first LLM chunk idle timeout after <firstChunkIdleTimeoutMs>ms
```

#### Token effect

Zero while a stream produces a result before the deadline; a timeout replaces the absent provider result with one terminal failure chunk.

#### KV Cache effect

Independent; the plugin does not rewrite the request or any model-visible prefix.

## Known Limitations and Deferred Work

- **Provider cancellation** — the frozen request and zero-argument continuation cannot inject a derived signal into a provider already blocked in its own read. The timeout is an agent-facing first-result deadline; transport cancellation remains the provider's existing `signal` contract.
- **Profile composition** — this package is opt-in and is not mounted until a deployment composes it.

The ownership rationale is recorded in the [fork Host overlay Agent Note](../../../.agents/notes/implemented/architecture/2026-08-22-fork-host-overlay.md).
