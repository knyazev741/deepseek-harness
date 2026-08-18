# Phase 3 — MCP gateway, approval seam, agent-driven sessions, bounds

Spec: [`…2026-08-18-external-interactive-agent-sessions.md`](../../notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md). Execution protocol and Global Constraints: [phase-1.md](phase-1.md). Same rule as Phase 2: detailed per-task plans after Phase 2 settles.

## Task 3.1 — `mcp-gateway` (harness tools served to external agents)

- New package in `packages/mcp/`: serve selected `ctx.tools` over stdio MCP to one external child (mirror of `mcp-client`, inverted). Tool allowlist is explicit per mode/session (Config + per-session selection; never ambient `ctx.tools` wholesale).
- External child config: ACP agents get it as an MCP server entry; Codex via its MCP config; Claude via SDK `mcpServers`.
- Security stance documented: harness-mediated actions run under harness policy (tool pipeline, sandbox, audit); native child tools remain outside mediation — the README states this boundary, it is the spec's "policy-shaped inheritance".
- Acceptance: an external agent calls a harness tool through the gateway; the call appears in harness tool pipeline with sandbox policy applied; denial path fail-closed.

## Task 3.2 — Turn-less approval + audit parity

- Extend the approval seam with the external-session variant: `ctx.approval` request carried by an external session (no open DSH turn) with the same `approval/asked`/`approval/decided` audit pair; Phase 1's ask-user bridge becomes the human-answer UI behind it (one decision channel, not two).
- The `external/permission-*` events remain as the transcript projection; the audit pair remains the authority. Fail-closed semantics unchanged.

## Task 3.3 — Agent-driven external sessions (`subagent` provider)

- One new subagent provider over `ctx.externalSessions`: an agent starts an external session as a continuable-style child — but the ownership graph stays session-level (the external child has no DSH inbox), so this provider registers through the one-shot surface with an explicit `interactive` lifecycle the subagent service must learn to name (this is the seam decision Phase 3 owns; resolve against `docs/subsystems/subagent.md`'s activation contract and record the outcome in the spec note before coding).
- Permission requests inside agent-driven external sessions route through Task 3.2's seam — machine policy via the delegating agent's answerers, human escalation when policy is `ask`.
- Acceptance: parent agent starts/steadies/collects from an external child; parent authority checks mirror `interrupt`/`followup` semantics where the wire allows; spec acceptance criterion "agent-started external session is authorized as a subagent child" holds.

## Task 3.4 — Retention, coalescing bounds, telemetry

- Bounded external event retention per session (apply-limits rule: byte/item caps on `external/*` appends, tested at tiny/exact/oversized/multibyte).
- Telemetry: token/turn counts surfaced from provider usage where the wire reports it (Codex usage events, ACP cost fields) into existing telemetry surfaces; no parent-context token growth ever.

## Task 3.5 — Note lifecycle + release sweep

- Spec note moves `proposed → implemented` (Decision rewrite per the note rules) or is split per-phase if Phase 3 slips; supersession audit re-run; website/docs final sync; limitations gates.

## Watch item (not a task)

Grok Build: no wire today. Re-evaluate when an ACP adapter or a stable CUI protocol appears; the terminal-adapter alternative stays rejected (spec note).
