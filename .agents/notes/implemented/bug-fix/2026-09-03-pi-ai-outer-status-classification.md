# Agent Note: Classify the outer pi-ai gateway status before nested error text

Status: implemented

English | [中文](2026-09-03-pi-ai-outer-status-classification.zh.md)

## Problem

pi-ai delivers provider failures to the adapter as flattened `errorMessage` text instead of a stable HTTP status field. A gateway response such as `502: {"message":"Upstream returned HTTP 400.","type":"api_error","code":"upstream_error"}` therefore contains two statuses: the outer status received by pi-ai and a nested diagnostic. The broad text classifier can select the nested `400` first and emit `INVALID_REQUEST`, which is intentionally outside the default retryable set. A transient gateway failure then closes the agent turn instead of entering the existing provider retry path.

## Decision

`dsh-llm-pi-ai` extracts an HTTP status from the start of flattened pi-ai errors, including bare status prefixes, `HTTP <status>`, and known parenthesized provider prefixes. `classifyPiAiError` uses that outer status before inspecting nested text: 401/403 map to `AUTH`, 429 preserves quota detection or maps to `RATE_LIMIT`, 400/413 map to `INVALID_REQUEST`, and 5xx maps to `SERVER`. Messages without a recognizable outer status retain the existing text-based fallback classification. This complements [pi-ai transport truncation classification](../../archived/bug-fix/2026-07-22-pi-ai-transport-truncation-classification.md); it does not make the catch-all `PI_AI_ERROR` or real `INVALID_REQUEST` failures retryable.

## Alternatives considered

**Add `INVALID_REQUEST` to the retryable codes.** Rejected because a genuine malformed request would be resent without changing its input and could consume the entire retry budget or an always policy. The recoverable case is the gateway's outer 5xx, so classification is corrected at the adapter.

**Treat the nested upstream status as authoritative.** Rejected because the nested status is diagnostic text inside the response body; the status that pi-ai received determines whether the gateway request itself failed transiently. The outer status must win when both are present.

**Replace pi-ai with a lower-level fetch adapter.** Rejected because it would duplicate provider protocol and catalog ownership to recover a status that can be safely classified from the flattened prefix. The adapter continues to use pi-ai and keeps its existing fallback for providers that omit a usable prefix.

## Consequences

Gateway 5xx responses wrapped around an inner 4xx now map to `SERVER` and enter the configured provider retry policy. Direct 400/413 responses remain terminal `INVALID_REQUEST`, so this fix does not retry malformed requests. The adapter still cannot recover a structured status that pi-ai discards; prefix parsing remains a best-effort compatibility rule for flattened messages.

## Testing

The pi-ai stream conversion test covers the observed `502` wrapper with nested `HTTP 400` text and asserts `SERVER`; the existing HTTP 400, 413, 429, quota, 5xx, transport, and context-overflow cases remain in the same suite.
