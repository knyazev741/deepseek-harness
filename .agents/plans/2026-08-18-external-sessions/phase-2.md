# Phase 2 — ACP provider + Claude Code dialect + unified model directories

Spec: [`…2026-08-18-external-interactive-agent-sessions.md`](../../notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md). Execution protocol and Global Constraints: [phase-1.md](phase-1.md). This outline becomes per-task detailed plans (same format as Phase 1) only after Phase 1's interfaces settle; task boundaries below are already reviewer-gate sized.

## Task 2.1 — `external-session-acp` provider

- Persistent ACP client: one `initialize` + `session/new { cwd }`, many `session/prompt` turns on the same session; stop-reason mapping table reused verbatim from `packages/subagent/subagent-acp` README.
- `session/update` → bridge: `agent_message_chunk` to `streamDelta` live + committed `external/message-added`; `tool_call`/`tool_call_update` → `external/tool-activity`; plan updates map to `external/tool-activity { kind: 'update' }` unless a dedicated event earns its place (default: no new event).
- `session/request_permission` → Task 5 bridge; options mapped to ACP `ApplyPromptResponse` outcomes (`allow_once`/`allow_always`/`reject`); the Phase 1 auto-answer config of subagent-acp does NOT carry over — interactive sessions answer interactively.
- Models: `session/models` capability when advertised (`modelDirectory: 'provider'`); agents without it fall back to the config roster.
- Config: `command`/`args`/`env`/`cwd` override/`disposeEofGraceMs`/`disposeGraceMs` (mirror subagent-acp names; disposal ladder identical).
- Keyless fixture: this harness's own ACP server (`packages/acp` + examples/acp-agent) as the child — dogfood double-role, no external dependency in CI.
- Acceptance: same criteria class as Phase 1 (stream, replay, permission round-trip, disposal), plus: works against a community ACP adapter list recorded in README evidence (e.g. Claude Code / Gemini adapters from the ACP agent catalog).

## Task 2.2 — `external-session-claude-code` dialect

- Official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, pin; same dependency policy as `packages/subagent/subagent-claude-code` incl. THIRD_PARTY_NOTICES implications).
- Persistent conversation: SDK resume by session id (persisted session id in external session metadata — durable, unlike subagent one-shot); `canUseTool` wired to the Task 5 bridge (this is the dialect's reason to exist); `mcpServers` left to Phase 3's gateway.
- Models: SDK model listing / settings-driven roster → `modelDirectory: 'config'` with settings-owned roster first, native listing when evidence shows a stable API.
- `persistSession` semantics decided explicitly and documented (interactive sessions WANT persistence for resume; contrast with the subagent provider's `false`).

## Task 2.3 — Unified model directory across modes

- The client model seat (Phase 1 Task 7) generalizes: directory source is `ctx.externalSessions.listModels(provider)` for every mode; effort/level selection arrives only where a provider advertises it (Codex efforts; ACP none; Claude per SDK).
- Snapshot: mode switch + model switch across all three modes in one assembled session-create flow.

## Task 2.4 — Docs + evidence sweep

- `docs/subsystems/external.md` grows the provider matrix (wire, persistence, approvals, models, disposal) — one table, one home.
- Update spec-note facts if wire reality diverged; Agent Note stays `proposed` until Phase 3 completes the family.
