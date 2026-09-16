# Agent Note: Compact at half-window pressure and force recovery after first-chunk timeout

Status: implemented

English | [中文](2026-09-08-half-window-and-forced-timeout-compaction.zh.md)

## Problem

The default `0.8` pressure threshold lets a 400k-context conversation grow to 320k tokens before compaction. DeepSeek response quality and first-chunk latency degrade before that point, and starting the summarizer only after the request is already that large makes recovery less reliable. A separate change also routed `FIRST_CHUNK_TIMEOUT` through normal pressure checks, so a timeout below the threshold retried the unchanged request without reproducing the established compact-then-continue recovery flow.

## Decision

`compaction-basic` defaults `thresholdRatio` to `0.5`, so automatic step-boundary compaction begins at 200k tokens for a 400k-context model unless configuration supplies another ratio. Exact provider/model policies still override the service default.

The opt-in `fork-llm-first-chunk-timeout` recovery remains independent of ordinary pressure. Every `FIRST_CHUNK_TIMEOUT` asks the selected compaction service for forced `context-overflow` compaction. Durable replacement ends the failed turn and queues the plugin-authored `continue` message after the agent reaches `idle`, as specified by the [first-chunk recovery decision](../feature/2026-08-27-fork-llm-first-chunk-compaction.md). No durable replacement delegates to downstream retry and cooldown policy.

## Alternatives considered

**Keep the `0.8` default and configure only known 400k models.** Rejected because the degraded final quarter is a common operating property and an omitted model override silently restores the late threshold. Deployments that need a later threshold can still override it explicitly.

**Use a separate `0.5` threshold only for first-chunk timeouts.** Rejected because it does not protect successful requests from accumulating degraded context between errors, and a timeout can require recovery below half-window pressure.

**Gate first-chunk recovery on normal pressure.** Rejected because the timeout is itself the recovery signal. It prevented compaction and the new-turn `continue` path in observed sessions even though repeated requests were not making progress. Provider overload can also cause the timeout, but no durable compaction progress falls back to the existing retry and cooldown chain.

## Consequences

Long sessions compact earlier and therefore pay summarization and KV-cache replacement more frequently in exchange for keeping ordinary requests away from the degraded end of the model window. A first-chunk timeout may start a summarizer during a provider outage even at low context pressure; cancellation, summarizer retry policy, the compaction retry ceiling, and durable-progress checks bound that recovery. Unit coverage pins the half-window default and forced trigger, while the real driver coverage pins the error-to-idle `continue` transition.
