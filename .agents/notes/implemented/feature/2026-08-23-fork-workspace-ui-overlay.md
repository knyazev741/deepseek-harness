# Agent Note: Fork Workspace UI overlay state and lifecycle

Status: implemented

English | [中文](2026-08-23-fork-workspace-ui-overlay.zh.md)

## Problem

The fork needs Background filtering, source attribution, local unread marks, and server-backed pin actions without changing the upstream Workspace browser or importing its private implementation modules.

## Decision

The overlay consumes the public `workspaceContributions` service and the two public Workspace row slots. Background includes running sessions and only the `github-actions` projection value. The source badge and three actions are separate list entries with stable ids. The pin policy partitions pinned rows first and returns zero within each partition so the upstream order remains authoritative there.

Read watermarks use the versioned browser key `dsh.fork.workspaceReadWatermarks.v1`; parsing is strict and malformed data falls back to an empty map. Pin state stays in a separate in-memory snapshot populated only by Host-accepted Remote results. A stale compare-and-set result triggers one list refresh and never replays the mutation; the next mutation requires a second explicit click.

All registrations, the current-session subscription, local store, and locale dictionary are effect-owned by the client fiber. Disposal therefore removes contributions, slots, subscriptions, and the namespace together.

## Alternatives considered

**Use `updatedAt` or a private `lastSeq` adapter.** Rejected because wall-clock metadata is not a durable log sequence and a private structural field is not a public client contract. The runtime now exposes the Host projection cut as `SessionSummary.projectionAsOfSeq`; the overlay leaves watermarks unchanged when that field is absent.

## Consequences

The client runtime carries the highest Host projection cut observed for each list row as `SessionSummary.projectionAsOfSeq`, separately from `updatedAt`. The overlay uses that durable sequence for unread marks, does not invent a sequence when the field is absent, and keeps pin snapshots revision-safe across late reads. The overlay adds no model-visible or transcript state.
