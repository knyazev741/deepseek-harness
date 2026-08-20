# Agent Note: Authenticated loopback MCP gateway for external Codex

Status: implemented

English | [中文](2026-08-20-authenticated-mcp-gateway.zh.md)

## Problem

An external Codex attachment needs a local Harness tool catalog without bypassing the external-principal pipeline, creating a native Agent, or placing a bearer credential in durable or model-visible data.

## Decision

`@deepseek-ai/dsh-mcp-gateway` owns one loopback Streamable HTTP lease per attachment. Authentication precedes parsing and dispatch, each lease uses an opaque route and random bearer, and the requested names are intersected with the configured allowlist and definition-level `externalEligibility: 'allow'` opt-in. Calls record one external call before `ctx.tools.execute` and one result or error after it; external approvals use the existing approval service's durable external bracket.

The Codex provider creates the lease before spawning its child, writes only the endpoint and `bearer_token_env_var` into the private Codex TOML, and passes the token through that explicit environment variable. Lease disposal is awaited before child teardown. Resume writes a fresh endpoint and token while retaining the hashed Codex home and rollout state.

The gateway enforces loopback binding, Streamable HTTP method/Accept/content-type/protocol ordering, strict JSON UTF-8/body byte and time bounds, bounded redacted results, session ownership, and fail-closed route/tool/disposal behavior. Pending recorder calls are finalized with one bounded cancellation result before the external scope closes. The gateway peer of the Codex provider is optional and the provider emits no runtime gateway import when it is absent; no default Web profile or client routing is changed here.

## Alternatives considered

**Direct definition execution.** Rejected because it skips tool guards, approval, validation, rendering, result observers, and external durable recording.

**Synthetic native Agent or turn.** Rejected because an external attachment has no native Agent lifecycle or native turn and fabricating either would make ownership and audit events ambiguous.

**Credential in URL or TOML.** Rejected because URLs, durable configuration, logs, events, and snapshots are observable beyond the child environment; the explicit bearer environment variable keeps the credential ephemeral.

## Testing

Focused gateway tests cover authentication order, allowlist/eligibility, MCP sessions, Streamable HTTP envelope/order, trailing JSON, UTF-8 and chunked byte limits, deadlines, bounded/redacted output, recorder pairs, disposal finalization, invariants, and a real Loader composition. Codex tests cover environment-only bearer injection, optional-peer loading without a gateway, provider-level gateway start/resume/teardown, and replacing the ephemeral MCP TOML section while retaining rollout files.

## Consequences

The MCP surface is intentionally limited to tools over one authenticated loopback route. Tool implementations must observe cancellation and settle owned work before lease disposal can complete. A later task owns opt-in bundles and client routing.
