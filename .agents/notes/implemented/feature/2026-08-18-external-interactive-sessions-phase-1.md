# Agent Note: External interactive sessions — Phase 1

Status: implemented

## Problem

The harness runs its own agent loop; console coding agents are one-shot subagent
providers that collapse a child run into a single tool result. A user cannot open
a session driven by an external agent: multi-turn continuation, live streaming,
agent-native compaction and model switching, and permission prompts have no
surface. This note records the Phase 1 landing of the external interactive
session family as settled; the design intent lives in the proposed
[external interactive agent sessions](../proposed/feature/2026-08-18-external-interactive-agent-sessions.md)
note, and the [claude-code-and-codex subagent backends](2026-08-04-claude-code-and-codex-subagent-backends.md)
note owns the one-shot sibling.

## Decision

A **mode** names who drives a session: `dsh` (the native agent loop) or a
registered external agent. The mode is a client-plane choice at creation, stamped
durably on the session header (default `dsh`). Phase 1 ships the Codex dialect;
ACP and Claude Code dialects are later phases.

Settled Phase 1 packages and responsibilities:

- `packages/external/external-session` — Service Definition `ctx.externalSessions`
  (registry of named providers, like `ctx.subagents`) plus the `ExternalSessionProvider`
  contract and `ExternalBridgeContext`. `compact()` is part of the provider contract:
  the harness never re-implements agent-native compaction across the wire.
- `packages/external/external-session-bridge` — host-side driver: owns provider
  lifecycle per external session, appends log-only `external/*` events through the
  Task-1 bridge, projects the transcript, and disposes the provider on session close.
- `packages/external/external-session-codex` — the Codex provider, driving
  `codex app-server --stdio` persistently (evidence-pinned at `@openai/codex@0.147.0`).
- `packages/interaction/external-permission` — Phase 1 permission bridge: routes
  `bridge.requestPermission` to the ask-user/user-questions channel with a
  permission-shaped ask; fail-closed on dismissal/timeout/no-answerer.
- `packages/client/ui-session-mode` — the client plugin: mode picker with model
  seat, and the external transcript conversation nodes.

External-mode session creation with a registered provider starts a bridge and never
a native Agent; an unknown mode fails loud at creation. A no-mode (`dsh`) session is
untouched.

### The `external/*` session events

The driver appends log-only events via `SessionEventMap` declaration merging, all
`ignorable: true` (unknown `external/*` on read does not corrupt replay). Live frame
deltas travel the frame channel without durability (`streamDelta` is never logged).
Committed units only:

`external/session-started`, `external/turn-started`, `external/message-added`,
`external/tool-activity`, `external/permission-asked`, `external/permission-decided`,
`external/model-switched`, `external/compaction-noticed`, `external/turn-ended`,
`external/session-ended`.

`/compact` and `/model` route per-session-mode: compaction calls the provider's
native compact and records the notice; model switching calls `setModel` and records
the switch. Unknown slash commands in external mode pass through as prompt text.

## Alternatives considered

The design alternatives and their rejections are argued in the proposed
[external interactive agent sessions](../proposed/feature/2026-08-18-external-interactive-agent-sessions.md)
note: a PTY terminal adapter (no structured stream, no log projection, no policy
inheritance), extending the one-shot subagent providers in place (their contract is
one final text), one generic wire for everything (ACP loses Codex thread resume and
Claude Code `canUseTool` specifics), and depending on community adapter packs for the
whole job (permission, sandbox, and MCP decisions stay harness-owned). Phase 1 shipped
the Codex dialect first per the plan's sequencing note; ACP is the Phase 2 wire.

## Phase 1 vs the approval seam

Phase 1 answers every child permission prompt through a human via the ask-user
interaction channel (there is no open DSH turn for an external session). Agent-driven
external sessions — authorization as a subagent child and routing permission requests
through `ctx.approval` with the audit pair — are a later phase; the two paths must not
diverge in audit semantics, and the later route supersedes rather than forks them.

## Consequences

A user can open a session driven by an external agent in this GUI: streaming turns
render in the same conversation UI and replay from the durable log, the mode picker
lists modes with per-provider model catalogs, model switching drives the child, a
rendered permission prompt gates the child with fail-closed dismissal/failure paths,
and the child runs under the harness sandbox with session-close process-tree
disposal. Phase 1 ships acceptance criteria 1–4 of the proposed note; criterion 5
(agent-started authorization + `ctx.approval` audit pair) is the later phase above.

External events are log-only and `ignorable: true`, so replay stays correct across
reload and unknown `external/*` on read does not corrupt it; the model-visible ⟺
logged rule holds because nothing external is model-visible in a parent session, and
there is no parent-context effect. Streamed deltas are not durable. The pinned Codex
fixture gates wire drift. Audit semantics must not diverge between the Phase 1
ask-user channel and the later `ctx.approval` route, which supersedes rather than
forks.
