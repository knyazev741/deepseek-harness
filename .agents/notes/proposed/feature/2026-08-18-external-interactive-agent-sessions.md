# Agent Note: External interactive agent sessions (ACP and native dialects)

Status: proposed

English | [中文](2026-08-18-external-interactive-agent-sessions.zh.md)

## Problem

The harness runs its own agent loop; console coding agents (Codex, Claude Code, ACP-speaking clients) exist here only as one-shot subagent providers ([the Codex and Claude Code backends](../../implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md)) that collapse a child run into one final tool result. A user cannot open a session in this GUI that is driven by an external agent, and later an agent cannot host one either: multi-turn continuation, live streaming, agent-native compaction, slash commands, native model catalogs, and permission prompts have no surface. The subagent seam's continuation manager is in-process by construction — a foreign process cannot enter its inbox contract — so interactivity cannot be retrofitted onto `SubagentProvider.start()`.

## Proposal

A **mode** names who drives a session: `dsh` (the native agent loop) or a registered **external agent** (`codex`, `claude-code`, any ACP client). The mode is a client-plane choice at session creation, not a preset: the picker composes the same host process, and the mode fixes the driving backend for that session.

New capability family `packages/external/`:

- `external-session` — Service Definition (`ctx.externalSessions`): start and stop a durable external session, submit prompts, stream agent activity, surface permission requests, list models, route commands. One registry with named providers, like `ctx.subagents`.
- `external-session-acp` — persistent ACP client: `session/new` once, then many `session/prompt` turns; `session/update` notifications project into the session log; `session/request_permission` is bridged to the user; the model directory comes from `session/models` where the agent advertises it. This is the primary wire and covers ACP-adapted clients.
- `external-session-codex`, `external-session-claude-code` — native dialects where ACP is lossy: resumable Codex threads and structured approvals, Claude Agent SDK resume and `canUseTool`, native compaction and model-switching APIs.

Session log: the bridge driver appends log-only `external/*` events (message deltas, tool activity, permission outcomes, compaction notices) carrying `ignorable: true`; replay renders the transcript. Nothing external is model-visible, so the model-visible⟺logged rule holds with no parent-context effect. Frame-level deltas coalesce under the client notifier discipline.

Policy inheritance, three layers: the child process spawns under the harness per-session sandbox confinement regardless of the agent's own sandbox claims; every permission request from the child is answered by a human through the ask-user interaction channel (Phase 1 has no open DSH turn, and [the approval seam](../../implemented/feature/2026-07-06-approval-seam.md) requires one — agent-driven sessions later route through `ctx.approval` with the same audit pair); and MCP exposure lands as a gateway that serves selected `ctx.tools` to the child as an MCP server, so harness-mediated actions run under harness policy.

Compaction and commands: the external agent owns its context compaction — the harness never re-implements it across the wire; the harness `/compact` command maps to the agent-native mechanism and records the notice. The command namespace splits harness commands from pass-through prompts.

Agent-driven sessions reuse the same family through one `subagent` provider over `ctx.externalSessions`; a session does not distinguish whether a human or an agent holds the steering wheel.

### Phase 1 settled surface

Phase 1 ships the Codex dialect. Settled implementation names: `ctx.externalSessions`
lives in `packages/external/external-session`; the host bridge driver is
`packages/external/external-session-bridge`; the Codex provider is
`packages/external/external-session-codex` (evidence-pinned at
`@openai/codex@0.147.0`); the Phase 1 ask-user permission bridge is
`packages/interaction/external-permission`; and the client plugin (mode picker +
external transcript nodes) is `packages/client/ui-session-mode`. A session's mode is
stamped durably on its header at creation, defaulting to `dsh`.

## Alternatives considered

- **PTY terminal adapter over `packages/terminal`:** rejected — no structured stream, no session-log projection, no policy inheritance; the transcript would be video, not data.
- **Extend the one-shot subagent providers in place:** rejected — their contract is one final text; interactive sessions are user-owned, multi-turn, and outlive any parent turn. [Interactive side sessions](2026-07-08-interactive-side-sessions.md) rejected the subagent seam for the same reason from the user-driven side.
- **One generic wire for everything:** rejected — ACP loses Codex thread resume and Claude Code `canUseTool` specifics; dialects stay.
- **Depend on community adapter packs for the whole job:** rejected as policy — adopting the ACP wire is fine, but permission, sandbox, and MCP decisions stay harness-owned.

## Acceptance criteria

- A session created in an external mode streams turns into the same conversation UI, replays identically after refresh from the durable log, and `/compact` compacts through the agent-native mechanism with a visible notice.
- The mode picker lists external modes with their model catalogs; selecting a model switches the child's model.
- A child permission prompt rendered in the UI gates the child; dismissal and failure paths fail closed.
- The child process runs under the harness sandbox policy; closing the session disposes the process tree.
- An agent-started external session is authorized as a subagent child, and its permission requests route through `ctx.approval` with the audit pair.

## Risks

- Wire drift: ACP evolves and the Codex app-server protocol is evidence-pinned (0.147.0); schema versioning and pinned fixture tests must gate upgrades.
- Inheritance is policy-shaped, not identical: the child's own native tools remain outside harness mediation until the MCP gateway lands.
- Streamed external events grow the session log; coalescing and retention need bounds under the apply-limits rule.
- TUI-only agents (Grok Build today) have no wire; they stay out of scope until an ACP adapter or a stable wire protocol exists.
- Two approval paths (Phase 1 ask-user channel, later `ctx.approval`) must not diverge in audit semantics; the Phase 3 route supersedes rather than forks them.
