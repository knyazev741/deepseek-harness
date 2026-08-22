# Agent Note: External interactive agent sessions (ACP and native dialects)

Status: proposed

English | [中文](2026-08-18-external-interactive-agent-sessions.zh.md)

## Problem

The harness runs its own agent loop, and the opt-in Web bundle now provides the Codex dialect through a durable external session. ACP-speaking clients, Claude Code's native interactive dialect, and agent-started external sessions still need a design that preserves their wire-specific continuation and authorization semantics. The one-shot [Codex and Claude Code backends](../../implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md) remain a separate seam: their continuation manager is in-process by construction, so interactivity cannot be retrofitted onto `SubagentProvider.start()`.

## Proposal

A **mode** names who drives a session: `dsh` (the native agent loop) or a registered external agent. The shipped `codex` mode is a client-plane choice at session creation, not a preset; future ACP and Claude Code modes must preserve that choice and never fall back to a native Agent.

The shipped `packages/external/` family owns the provider registry, bridge, Codex wire, log-only events, and permission seam. The remaining proposal is:

- `external-session-acp` — persistent ACP client: `session/new` once, then many `session/prompt` turns; `session/update` notifications project into the session log; `session/request_permission` is bridged to the user; the model directory comes from `session/models` where the agent advertises it. This is the remaining generic wire for ACP-adapted clients.
- `external-session-claude-code` — native Claude Code dialect where ACP is lossy: SDK resume, `canUseTool`, native compaction, and model switching.
- Agent-started sessions — authorization through the external principal and `ctx.approval`, with the same audit-pair semantics as user-started external sessions.

The current bridge appends log-only `external/*` events carrying `ignorable: true`; replay renders the transcript and frame-level deltas remain live-only. New ACP and Claude providers must use the same event ownership and model-visible ⟺ logged rule.

Policy inheritance remains host-owned: the child process runs under the harness per-session sandbox, user-started permission requests use the ask-user channel, and MCP exposure uses the authenticated gateway and explicit tool allowlist. Agent-started sessions still require an authorization route through `ctx.approval` with the same audit pair.

Compaction and commands retain the shipped Codex semantics: the external agent owns context compaction, `/compact` maps to the native mechanism, and provider slash lines do not enter the native Agent command registry. ACP and Claude providers must expose equivalent native operations where their wires support them.

Agent-driven sessions may reuse the same family only after their authorization and lifecycle semantics are specified; the current Codex Web profile does not mount that provider.

### Phase 1 settled surface

Phase 1 ships the Codex dialect. Settled implementation names: `ctx.externalSessions` lives in `packages/external/external-session`; the host bridge driver is `packages/external/external-session-bridge`; the Codex provider is `packages/external/external-session-codex` (evidence-pinned at `@openai/codex@0.147.0`); the Phase 1 ask-user permission bridge is `packages/interaction/external-permission`; and the client plugin (mode picker + external transcript nodes) is `packages/client/ui-session-mode`. A session's mode is stamped durably on its header at creation, defaulting to `dsh`.

## Alternatives considered

- **PTY terminal adapter over `packages/terminal`:** rejected — no structured stream, no session-log projection, no policy inheritance; the transcript would be video, not data.
- **Extend the one-shot subagent providers in place:** rejected — their contract is one final text; interactive sessions are user-owned, multi-turn, and outlive any parent turn. [Interactive side sessions](2026-07-08-interactive-side-sessions.md) rejected the subagent seam for the same reason from the user-driven side.
- **One generic wire for everything:** rejected — ACP loses Codex thread resume and Claude Code `canUseTool` specifics; dialects stay.
- **Depend on community adapter packs for the whole job:** rejected as policy — adopting the ACP wire is fine, but permission, sandbox, and MCP decisions stay harness-owned.

## Acceptance criteria

- An ACP mode streams and replays a multi-turn session through the existing conversation UI, exposes its advertised model directory, and routes native compaction and permission requests without entering the native Agent loop.
- A Claude Code mode preserves SDK resume, `canUseTool`, native compaction, model switching, sandbox confinement, and process-tree disposal with durable `external/*` projection.
- An agent-started external session has an explicit principal and authorization path; permission requests route through `ctx.approval` and produce the same paired audit events as user-started approvals.

## Risks

- Wire drift: ACP evolves and the Codex app-server protocol is evidence-pinned (0.147.0); each new provider needs schema evidence and pinned fixtures.
- Native dialects differ in authorization and resume semantics; a provider must not silently fall back to the Codex or native DSH path.
- Agent-started authorization can expose parent-owned tools; principal scoping and the shared audit pair must remain enforced before dispatch.
- TUI-only agents have no supported wire; they stay out of scope until an ACP adapter or stable protocol exists.
