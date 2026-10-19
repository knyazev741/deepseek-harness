# Agent Note: Agent-set wake schedules

Status: implemented

English | [中文](2026-09-18-profile-wake-scheduler.zh.md)

## Problem

An agent that promises "I will check every 30 minutes" can keep that promise today only by starting a background job and waiting for its completion notice. That notice does not wake an idle session: completion notices queue and arrive in a batch with the next human message. Three jobs scheduled for 30, 60, and 120 minutes all fired on time, and all three notices were delivered together roughly two hours later, attached to a user message. The conversation stayed silent exactly when the periodic work was supposed to happen.

The session-local Schedule package already initiates a turn from a live owner, but its records are created by model tool calls and live in the session log; there was no way to declare "every N minutes, say this" in a profile. A first shape that read only profile configuration and bound one session id by hand was not usable: changing the interval meant editing `cordis.patch.yml`, and every change needed a restart.

## Decision

`@knyazevai/dsh-wake-scheduler` registers three agent-facing tools in each live root agent scope. `wake_schedule_set` writes a durable schedule for the calling session, `wake_schedule_status` reports it, and `wake_schedule_cancel` stops it; the session comes from the agent scope that owns the tool, never from an argument, so "вставай каждые полчаса" needs no profile edit and no restart. A due schedule initiates one ordinary turn through `agent.followup(createUserMessage(...))`, the same follow-up boundary a human message takes.

The change is additive and keeps upstream files untouched:

- The plugin is a new workspace package; no core package changes and no new loop extension point.
- It uses only existing seams: the `tools` registry, `agent/created`, `agent.followup`, and `ctx.storageDomain`.
- The durable schedule lives in a new `wake_scheduler` storage domain (table `schedules`), not in the session log, so no session event type is added and `SESSION_FORMAT_VERSION` is unchanged.
- A profile fallback seeded from `Config` is optional and disabled by default; a record the agent set or cancelled always wins over it.

Every live root agent is adopted, whether it was published before the plugin loaded or after it: the `agent/created` observation is registered before the durable store opens, a session published while that open is pending is adopted as soon as it resolves, and installation is idempotent per agent. Registration, arming, and a `ready` line naming the adopted session count are logged at `info`, so an operator can tell a plugin that never loaded from a session that never received tools.

Catch-up is latest-only and visible. A stored future target is honored exactly; a target already in the past — the process was down, or the session was cold — produces one immediate catch-up turn and records the collapsed interval count, which `wake_schedule_status` reports as `skippedIntervals` together with `overdue`. A failed follow-up writes nothing and retries one interval later, so a broken target cannot spin.

## Alternatives considered

**Ship only the profile-configured schedule with a hand-written session id.** This was the first shape, and it was rejected as UX: every interval change required editing `cordis.patch.yml` and restarting the harness, and the owner had to know and paste the session id.

**Extend `@knyazevai/dsh-schedule` with config-driven record creation.** Rejected: `schedule` is upstream code present in both merge parents of the last upstream merge, so editing it creates a standing conflict surface. Appending its `schedule/change` events from another plugin would also reach into another package's event namespace and make sessions unreadable to builds that do not know that type.

**Reuse the background-job notification path.** Rejected: that path is exactly the observed failure. Its notices do not wake an idle driver, and making them wake would change existing job behavior, which the request forbids.

**Persist the schedule in the session log as a new event type.** Rejected: an unknown `SessionEventMap` member is required-on-read, so a log written by this build would be refused by a build without the plugin unless the event were marked `ignorable`. Host-side operational state in `storageDomain` keeps the session format stable.

**Wake a cold persisted session through `ctx.agents.resume`.** Deferred, not rejected: it would let a wake fire when nobody has opened the session in the running process, but it needs an ownership and disposal answer for a scheduler-created agent that the Web host may later resume itself. The catch-up turn covers the cold case on the next load instead.

## Consequences

The agent now owns its own cadence: once the overlay is mounted and the conversation has been opened in the running `dsh` process, a set schedule fires with no browser and no user message, and the agent can inspect or stop it in the same conversation. A schedule survives a restart, and a session that was closed while a wake came due receives exactly one catch-up turn on its next load rather than a backlog.

Costs accepted: the host-side record does not travel with a fork and is not visible in cold history; a crash between the follow-up and the durable advanced record can repeat one wake; and a session that is never loaded again never gets its catch-up turn, because no external channel exists.

Coverage: `tests/scheduling.spec.ts` pins the arithmetic and the status view, `tests/runtime.spec.ts` pins one-turn-per-interval, catch-up, containment, arming diagnostics, and disposal against a mocked session layer, `tests/tools.spec.ts` pins set/status/cancel validation and durable mutations, and `tests/plugin.spec.ts` pins adoption of a pre-existing root, of a session published while the store opens, of a later resume, idempotent re-installation, fallback seeding, tool-over-config priority, cancellation, and the restart catch-up. All five source files hold per-file 100% statement, branch, function, and line coverage. `tests/composition.spec.ts` mounts the plugin in a real Cordis `Context` over the agent-loop testkit services and pins both directions of injection: it activates and opens the store once every injected service exists, and stays inert until it does. Harvesting these schemas into the generated tool catalog and a subprocess profile boot are still missing.
