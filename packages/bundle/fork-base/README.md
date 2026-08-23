# `@deepseek-ai/dsh-fork-base`

English | [中文](README.zh.md)

The opt-in Host fork overlay: [`cordis.patch.yml`](cordis.patch.yml) inserts three independently owned fork packages after [`dsh-base`](../base/README.md). Add this bundle after `@deepseek-ai/dsh-base` when a deployment wants session provenance, workspace pin state, and a bounded wait for the first LLM stream result.

## Composition

The patch is insert-only. It adds `fork-session-source`, `fork-workspace-session-state`, and `fork-llm-first-chunk-timeout` in that order. The timeout row carries the explicit validated value `firstChunkIdleTimeoutMs: 120000`; a profile or later `--patch` layer may disable or reconfigure any row by id. The bundle does not mount the provider-neutral external-session registry or any Codex provider.

The session-state row waits for the `workspaceRegistry` supplied by a Host surface. This keeps the fork bundle reusable across Host compositions while preserving Loader dependency ordering.

## Mounted capabilities

- [`fork-session-source/`](../../fork/session-source/README.md) records the optional GitHub Actions source marker and exposes its nullable projection.
- [`fork-workspace-session-state/`](../../fork/workspace-session-state/README.md) persists the ordered workspace-session pin list and exposes its generated Remote.
- [`fork-llm-first-chunk-timeout/`](../../fork/llm-first-chunk-timeout/README.md) bounds only the idle wait before the first LLM stream result.

Each capability remains owned by its package and can be removed or replaced independently when the upstream base changes.

## Model Experience

### Host overlay rows

#### What the model sees

No prompt section, tool schema, message, or request field is added. The bundle's timeout row changes only the failure path when a provider produces no first result before the configured deadline; the provenance and pin rows remain Host-only.

#### Token effect

Zero for successful requests. A first-result timeout replaces an absent provider result with one terminal `TIMEOUT` failure chunk and does not add a retry request by itself.

#### KV Cache effect

The mounted packages do not rewrite model-visible input or alter a successful request prefix, so there is no direct cache invalidation.

## Known Limitations and Deferred Work

- The workspace-session row requires a Host composition that provides `workspaceRegistry`; a profile that does not mount that service leaves the row waiting for its declared dependency.
- The bundle intentionally leaves external-session provider selection and the Codex integration to a future, explicitly composed overlay.
