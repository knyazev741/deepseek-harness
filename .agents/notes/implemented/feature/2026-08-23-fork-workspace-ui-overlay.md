# Agent Note: Fork Workspace UI overlay state and lifecycle

Status: implemented

English | [中文](2026-08-23-fork-workspace-ui-overlay.zh.md)

## Problem

The fork needs Background filtering, source attribution, local unread marks, and server-backed pin actions without changing the upstream Workspace browser or importing its private implementation modules.

## Decision

The overlay consumes the public `workspaceContributions` service and the three public Workspace row slots. Background includes running sessions and only the `github-actions` projection value. The source badge remains a separate list entry, one status entry renders the green completion dot for a stale read watermark only while the session is idle and not selected, and one action entry renders Copy session ID, Mark unread, and Pin inside the browser-owned session menu. The browser-owned pending, activity, and completion statuses take precedence over the unread entry, so overlapping completion and watermark state still renders one indicator. Pin state contributes both a stable comparator and a promotion predicate: pinned sessions render once in the shared top `Pinned` section above every Workspace, while unpinned sessions remain in their source Workspace order.

Read watermarks use the versioned browser key `dsh.fork.workspaceReadWatermarks.v1`; parsing is strict and malformed data falls back to an empty map. Entering a session clears its explicit unread state, while every later projection update observed in that current session advances the watermark without clearing a new explicit mark. Pin state stays in a separate in-memory snapshot populated only by Host-accepted Remote results. A stale compare-and-set result triggers one list refresh and never replays the mutation; the next mutation requires a second explicit click.

All registrations, the current-session subscription, local store, and locale dictionary are effect-owned by the client fiber. Disposal therefore removes contributions, slots, subscriptions, and the namespace together; removing the overlay also removes its promotion and unread status from the upstream browser without changing browser-owned state.

## Alternatives considered

**Use `updatedAt` or a private `lastSeq` adapter.** Rejected because wall-clock metadata is not a durable log sequence and a private structural field is not a public client contract. The runtime now exposes the Host projection cut as `SessionSummary.projectionAsOfSeq`; the overlay leaves watermarks unchanged when that field is absent.

## Consequences

The client runtime carries the highest Host projection cut observed for each list row as `SessionSummary.projectionAsOfSeq`, separately from `updatedAt`. The overlay uses that durable sequence for unread marks, does not invent a sequence when the field is absent, and keeps pin snapshots revision-safe across late reads. The overlay adds no model-visible or transcript state.
