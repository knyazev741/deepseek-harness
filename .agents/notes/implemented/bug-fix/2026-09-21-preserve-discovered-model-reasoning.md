# Agent Note: Preserve reasoning metadata during model discovery

Status: implemented

English | [中文](2026-09-21-preserve-discovered-model-reasoning.zh.md)

## Problem

OpenAI-compatible model directories may publish model-specific reasoning levels, but DSH discovery previously retained only the id, name, context window, and output-token limit. Adopting that result wrote a user-owned `models` array, which replaces the bundle catalog. A model such as GLM 5.3 Flash therefore remained selectable while losing its Effort menu, even when the checkout itself was current. Pulling newer source could not repair the already-saved model row.

The KnyazevAI bundle also carried catalog facts that no longer matched the live API: Kimi 2.6 remained listed, DeepSeek advertised a larger output limit than the endpoint, and reasoning compatibility differed between the standalone provider and the full fork.

## Decision

`LlmDiscoveredModel` carries optional `reasoningEfforts`. The pi-ai discovery parser reads `reasoning.efforts` from OpenAI-compatible listings. An off-only list becomes `false`; otherwise each published level is retained. If the listing declares a thinking level as the default, Off maps to the explicit `off` wire value so omission cannot leave default thinking enabled; otherwise Off maps to the absent wire value.

The Models editor adopts this hidden capability metadata with the visible model row. An existing row starts selected when endpoint discovery can repair its reasoning metadata. Adoption updates only that metadata for an existing model, preserving names and capacities the user already tuned.

The KnyazevAI fork bundle mirrors the live `/v1/models` catalog: DeepSeek V4 Flash, GLM 5.3 Flash, and MiniMax 2.7; Kimi 2.6 is absent. Route-level OpenAI reasoning compatibility applies to DeepSeek and GLM, MiniMax is explicitly non-reasoning, and output limits match the endpoint.

## Alternatives considered

**Hard-code a KnyazevAI-only repair in the UI.** That would fix one provider while leaving every other OpenAI-compatible directory able to lose the same metadata.

**Rewrite stored settings automatically at startup.** Startup cannot safely infer whether a hand-edited model row intentionally removed reasoning support, and silent writes would change user configuration without an explicit adoption action.

**Keep endpoint discovery limited to visible fields.** This preserves the old narrow response but makes the Fetch available models action destructive for capability metadata that controls request behavior.

## Consequences

Gateways can preserve reasoning selectors through discovery when they publish `reasoning.efforts`. Existing rows with stale reasoning metadata are offered for repair without overwriting tuned capacities. Gateways that omit the field retain the previous behavior. The full KnyazevAI fork and standalone provider now share the same live model catalog and reasoning semantics.
