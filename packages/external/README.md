# external/ — external interactive-agent session family

English | [中文](README.zh.md)

This family lets a session be driven by an external console agent (Codex, Claude Code, an ACP client) instead of the native agent loop. A **mode** chosen at session creation names one registered provider; the mode is a client-plane choice, not a preset. The design and phase sequencing live in [the external interactive agent sessions spec note](../../.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md).

| Package | Role | ctx key |
|---|---|---|
| [`external-session/`](external-session/README.md) | Service Definition: named-provider registry, session dispatch, the per-session bridge | `ctx.externalSessions` |
| `external-session-codex/` | Codex dialect provider (in development; evidence transcripts under `tests/evidence/`) | registers on `ctx.externalSessions` |

The ACP provider dialect is planned; see the spec note's phase plan.
