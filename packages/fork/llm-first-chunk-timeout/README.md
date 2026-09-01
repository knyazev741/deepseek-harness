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

On a `FIRST_CHUNK_TIMEOUT` failure the plugin prepends an `agent/request-error` listener that forces one context compaction through the agent's isolated `compaction` service when `agentPresets.serviceFor(agent, 'compaction')` provides one, otherwise through the host `compaction` service (`context-overflow` trigger). The compaction operation remains active while its summarizer performs provider-policy retries and cooldown waits. Durable compaction progress stages a plugin-authored message containing exactly `continue`, while the listener returns no retry action. The timed-out request ends with its original error; when its driver reaches `idle`, `agent.followup()` inserts the staged message and wakes a new turn from the replacement surface. Delaying insertion until `idle` is required because a follow-up inserted inside the failing driver remains queued after that driver exits. Fast `dsh-llm-retry` backoff is skipped because it cannot fix a stalled first chunk. `maxFirstChunkCompactionRetries` (default `3`) bounds consecutive compaction follow-ups until the recovery activity completes; reaching the ceiling or making no durable progress ends the timeout turn without another continuation. Without either an isolated or host `compaction` engine the listener delegates through `next()`, preserving the plugin's standalone behavior.

## Model Experience

### Stream failure

#### What the model sees

The plugin adds no prompt section or tool schema. When the first-result deadline wins, the stream terminates with the stable diagnostic and `FIRST_CHUNK_TIMEOUT` failure code below. After successful recovery the next turn receives the durable user-role continuation message with plugin provenance.

##### Timeout diagnostic

```markdown
first LLM chunk idle timeout after <firstChunkIdleTimeoutMs>ms
```

##### Continuation message

```markdown
continue
```

#### Token effect

Zero while a stream produces a result before the deadline. Successful timeout recovery adds the short `continue` message and a new model request after compaction.

#### KV Cache effect

Successful recovery uses the compaction replacement surface and appends `continue`, so the new request has a different model-visible prefix and does not reuse the timed-out request verbatim.

## Known Limitations and Deferred Work

- **Provider cancellation** — the frozen request and zero-argument continuation cannot inject a derived signal into a provider already blocked in its own read. The timeout is an agent-facing first-result deadline; transport cancellation remains the provider's existing `signal` contract.
- **Profile composition** — this package is opt-in and is not mounted until a deployment composes it.

The ownership rationale is recorded in the [fork Host overlay Agent Note](../../../.agents/notes/implemented/architecture/2026-08-22-fork-host-overlay.md).
