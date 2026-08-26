# `@deepseek-ai/dsh-fork-base`

English | [中文](README.zh.md)

The opt-in Host fork overlay: [`cordis.patch.yml`](cordis.patch.yml) inserts four independently owned fork packages after [`dsh-base`](../base/README.md) and overrides upstream model rows with portable Knyazev AI defaults. Add this bundle after `@deepseek-ai/dsh-base` when a deployment wants the fork Host capabilities and the Knyazev AI route.

## Composition

The patch first inserts `fork-session-source`, `fork-workspace-session-state`, `fork-llm-first-chunk-timeout`, and `fork-llm-rate-limit-cooldown` in that order, then replaces the complete config of the upstream `llm-pi-ai` and `agent-default-model` rows by id. The timeout row carries `firstChunkIdleTimeoutMs: 120000`; the cooldown row carries `cooldownMs: 600000`; the model row configures `knyazev-ai` with `api: openai-completions` at `https://knyazevai.work/v1`, `streamIdleTimeoutMs: 900000`, `timeoutMs: 1800000`, `compat.thinkingFormat: qwen`, `compat.supportsReasoningEffort: false`, `reasoning: high`, and `retryPolicy.mode: normal`, `maxRetries: 20`, with retryable codes ordered `RATE_LIMIT`, `QUOTA`, `SERVER`, `TIMEOUT`, `FIRST_CHUNK_TIMEOUT`, `TRANSPORT`, `STREAM_CLOSED`, `EMPTY_RESPONSE`. Its models are `deepseek-v4-flash` (context window `400000`, max tokens `128000`), `kimi-2.6` (`262144`, `40000`), and `minimax-2.7` (`204800`; no max-token override). The default-model row selects `knyazev-ai/deepseek-v4-flash` and intentionally carries no `reasoningEffort` composition field.

The route stores only the credential reference `apiKeyEnv: KNYAZEV_AI_API_KEY`; the key value remains in the external credentials or environment layer and never enters Git. The user settings document is above this composition base, so partial `llm-pi-ai` or `agent-default-model` settings override matching fields while omitted fields inherit the portable defaults. A profile, home, or `--patch` row still replaces its targeted plugin config wholesale. The bundle does not mount the provider-neutral external-session registry or any Codex provider.

The session-state row waits for the `workspaceRegistry` supplied by a Host surface. This keeps the fork bundle reusable across Host compositions while preserving Loader dependency ordering.

## Mounted capabilities

- [`fork-session-source/`](../../fork/session-source/README.md) records the optional GitHub Actions source marker and exposes its nullable projection.
- [`fork-workspace-session-state/`](../../fork/workspace-session-state/README.md) persists the ordered workspace-session pin list and exposes its generated Remote.
- [`fork-llm-first-chunk-timeout/`](../../fork/llm-first-chunk-timeout/README.md) bounds only the idle wait before the first LLM stream result.
- [`fork-llm-rate-limit-cooldown/`](../../fork/llm-rate-limit-cooldown/README.md) retries a persistently limited request (default `RATE_LIMIT`/`429` or upstream `SERVER`/`5xx`) after `cooldownMs` once the provider's bounded `llm-retry` budget is exhausted.

Each capability remains owned by its package and can be removed or replaced independently when the upstream base changes.

## Model Experience

### Host overlay rows

#### What the model sees

No prompt section, tool schema, message, or request field is added. The portable route changes the default provider/model and request endpoint, while the timeout row changes only the failure path when a provider produces no first result before the configured deadline; the provenance and pin rows remain Host-only.

#### Token effect

Zero for successful requests. A first-result timeout replaces an absent provider result with one terminal `TIMEOUT` failure chunk and does not add a retry request by itself.

#### KV Cache effect

The mounted packages do not rewrite model-visible input or alter a successful request prefix, so there is no direct cache invalidation.

## Known Limitations and Deferred Work

- The workspace-session row requires a Host composition that provides `workspaceRegistry`; a profile that does not mount that service leaves the row waiting for its declared dependency.
- `KNYAZEV_AI_API_KEY` must resolve through the process environment or credentials service before a Knyazev AI request can authenticate; a missing value fails the request instead of being committed to the bundle.
- A user settings section can replace the portable provider or default-model values, and a later patch can replace their complete plugin configs by id.
- The bundle intentionally leaves external-session provider selection and the Codex integration to a future, explicitly composed overlay.
