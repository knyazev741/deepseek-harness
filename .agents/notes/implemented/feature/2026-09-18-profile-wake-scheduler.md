# Agent Note: Profile-configured wake scheduler

Status: implemented

English | [中文](2026-09-18-profile-wake-scheduler.zh.md)

## Problem

An agent that promises "I will check every 30 minutes" can keep that promise today only by starting a background job and waiting for its completion notice. That notice does not wake an idle session: completion notices queue and arrive in a batch with the next human message. Three jobs scheduled for 30, 60, and 120 minutes all fired on time, and all three notices were delivered together roughly two hours later, attached to a user message. The conversation stayed silent exactly when the periodic work was supposed to happen.

The session-local Schedule package already initiates a turn from a live owner, but its records are created by model tool calls and live in the session log. There was no way to declare "every N minutes, say this" in a profile and have it start without a user turn.

## Decision

`@knyazevai/dsh-wake-scheduler` is a new opt-in function plugin in the `schedule` group. It reads one profile configuration — `enabled`, `intervalMinutes`, `prompt`, optional `sessionId`, and optional `startDelayMinutes` — and initiates one ordinary turn per interval in each matching live root session by calling `agent.followup(createUserMessage(...))`, the same follow-up boundary a human message takes.

The change is additive and keeps upstream files untouched:

- The plugin is a new workspace package; no core package changes and no new loop extension point.
- It observes only `agent/created` and drives only public Agent methods, so it adds nothing to the agent loop or the job notification path.
- The durable next-run cursor lives in a new `wake_scheduler` storage domain (table `cursors`), not in the session log, so it introduces no session event type and no `SESSION_FORMAT_VERSION` change.
- The default is off; an enabled profile configuration is the only way it does anything.

Catch-up is latest-only: a stored future target is honored exactly, and a target already in the past produces one immediate wake rather than a replay. A failed follow-up writes no cursor and retries one interval later. A fired wake arms its next timer from the computed target instead of re-reading the cursor after the durable write, so a failed write cannot produce an immediate second wake.

The overlay is `apps/cli/config/examples/wake-scheduler/cordis.yml`. `apps/cli` declares the package and `tsconfig.base.json` maps it, so the example overlay resolves to workspace source for the tsx source launch instead of depending on built `lib/`.

## Alternatives considered

**Extend `@knyazevai/dsh-schedule` with config-driven record creation.** Rejected: `schedule` is upstream code present in both merge parents of the last upstream merge, so editing it creates a standing conflict surface. Appending its `schedule/change` events from another plugin would also reach into another package's event namespace and make sessions unreadable to builds that do not know that type. A sibling package leaves the upstream tree untouched.

**Reuse the background-job notification path.** Rejected: that path is exactly the observed failure. Its notices do not wake an idle driver, and making them wake would change existing job behavior, which the request forbids.

**Persist the cursor in the session log as a new event type.** Rejected: an unknown `SessionEventMap` member is required-on-read, so a log written by this build would be refused by a build without the plugin unless the event were marked `ignorable`. Host-side operational state in `storageDomain` keeps the session format stable.

**Wake a cold persisted session through `ctx.agents.resume`.** Deferred, not rejected: it would let a wake fire when nobody has opened the session in the running process, but it needs an ownership and disposal answer for a scheduler-created agent that the Web host may later resume itself.

## Consequences

The plugin closes the observed gap for the case that produced it: once `dsh web` has started and the target conversation has been opened, the Web host keeps that agent live for the process lifetime, so a wake fires with no browser and no user message. It does not reach a session that was never opened in the running process, and it has no external channel.

Costs accepted: the host-side cursor does not travel with a fork and is not visible in cold history; a crash between the follow-up and the durable cursor can repeat one wake; and omitting `sessionId` schedules every root agent created after load, which is deliberate for a single-conversation profile and surprising for a multi-conversation one.

Coverage: `tests/scheduling.spec.ts` pins cadence arithmetic, `tests/runtime.spec.ts` pins one-turn-per-interval, catch-up, containment, and disposal against a mocked session layer, and `tests/plugin.spec.ts` pins configuration validation and the composed wiring. All three source files hold per-file 100% statement, branch, function, and line coverage. A subprocess real-composition or Web e2e is still missing: the one-minute minimum interval makes a browser test that waits for a wake impractical as written.
