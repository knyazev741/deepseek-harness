---
description: "Opt-in profile-configured wake scheduler: an interval and prompt that initiate a turn in matching live root sessions without a user message, for owners who need unattended periodic work."
kind: "package-reference"
---

# @knyazevai/dsh-wake-scheduler

English | [中文](README.zh.md)

## Summary

Wake Scheduler initiates an ordinary turn in a matching live root session on a profile-configured interval, using the same follow-up path a human message takes, so no background job and no notification delivery are involved. It exists because background-job completion notices queue while a session is idle and only surface on the next human activity, which makes "check every 30 minutes" fail whenever nobody writes to the conversation. The scheduler is disabled by default, has no tools and no model-visible surface of its own, and never leaves the session: no email, SMS, push, or browser notification.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Choose Wake Scheduler when a conversation must keep working on its own — a periodic check-in, a long watch, a scheduled review — and the session stays live in a running `dsh` process. Avoid it when the work must reach you outside the session, when the process may be down at the target time, or when you need calendar or Cron rules: the interval is fixed and whole-minute.

### Enable Wake Scheduler

Mount the overlay and set the profile configuration; the scheduler is inert until `enabled` is `true`:

```sh
dsh web --patch apps/cli/config/examples/wake-scheduler/cordis.yml
```

```yaml
- insert:
    - id: wake-scheduler
      name: '@knyazevai/dsh-wake-scheduler'
      config:
        enabled: true
        intervalMinutes: 30
        prompt: 'Scheduled check-in: continue the plan and report anything that needs my decision.'
        # sessionId: session-...   # omit to schedule every root session
        # startDelayMinutes: 30    # first wake delay; defaults to intervalMinutes
```

Success looks like one new user turn in the target conversation every 30 minutes, each tagged by the plugin source, plus an `info` log line naming the session and the run number. A disabled configuration — the default — loads the plugin as a no-op, opens no storage, and changes nothing.

### Configuration

| Field | Required | Meaning |
|---|---|---|
| `enabled` | no (default `false`) | Runs the scheduler. Every other field is ignored while false. |
| `intervalMinutes` | yes when enabled | Whole minutes between wakes, at least 1. |
| `prompt` | yes when enabled | Non-empty text of the turn the scheduler initiates. |
| `sessionId` | no | Binds the schedule to one conversation. Omitted, every root agent created while the plugin is loaded is scheduled. |
| `startDelayMinutes` | no | Whole minutes from load to the first wake when no cursor is stored. Defaults to `intervalMinutes`. |

An enabled run with a missing interval or blank prompt fails at plugin load instead of silently doing nothing.

### What happens across restarts

The last and next wake instants are stored in the `wake_scheduler` storage domain, not in the session log. After a restart the scheduler reads the cursor back: a still-future target is honored exactly, and a target already in the past produces one catch-up wake. Missed intervals are never replayed as a backlog, and one interval never produces more than one turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Scope and composition

The plugin declares `inject = ['agents', 'storageDomain']` and is a function plugin with `name` / `inject` / `Config` / `apply`. It observes only `agent/created` events published after it loads, arms a timer for each matching root agent, and unwinds every timer through the agent's own scoped effect on disposal. Agents already live at load time are not adopted, and subagents are never scheduled.

### Where the turn comes from

A due wake calls `agent.followup(createUserMessage({ content, source: { kind: 'plugin', plugin: 'wake-scheduler' } }))`. This is the loop's ordinary follow-up boundary: it queues a normal user turn and wakes the driver, and it never steers or interrupts work already running. Nothing in this package creates a background job, appends a private session event type, or touches the job notification path.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: configuration, `agent/created` observation, cursor domain, per-agent arming |
| [`src/runtime.ts`](src/runtime.ts) | Live timer owner: arm/disarm/dispose, one-turn dispatch, diagnostics |
| [`src/scheduling.ts`](src/scheduling.ts) | Pure cadence arithmetic: validation, next-due resolution, catch-up, timer segments |

### Durable state

The `wake_scheduler` domain (version 1, table `cursors`) holds one `{ lastRunAt, nextRunAt, runs }` record per session id. A dispatched wake persists the new cursor before re-arming, and the timer is armed from the computed target rather than from a re-read, so a failed cursor write cannot produce a second immediate wake. Writes resolve only after the backend is durable, so a restart reads back either the previous interval or the advanced one, never a torn value.

### Failure containment

A follow-up that throws is contained: the run advances no cursor, logs a `warn`, and the next attempt is one full interval later, which prevents a hot loop. A cursor write failure is contained the same way; the delivered turn stands and the next interval continues. A target that is no longer the registry's live root for that session is skipped. The scheduler's `dispose` clears every armed timer without deleting durable cursors.

### Why there is no `./invariant` companion

No invariant companion is published because the package reads no second observation that could diverge from the one it owns. Every write path is one synchronous `followup` followed by one durable `put` on the same value, so there is no independent observation to assert, and the companion and its wiring are omitted rather than shipped empty.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Schedule group](../README.md) — the sibling session-local reminder package, whose records also deliver as conversation turns.
- [Session-local Schedule subsystem](../../../docs/subsystems/schedule.md) — the reminder record and delivery contracts this package deliberately does not reuse.
- [Durable web Schedule decision](../../../.agents/notes/implemented/feature/2026-08-05-durable-web-schedule.md) — prior art for live-owner reminder delivery.
- [Profile-configured wake scheduler decision](../../../.agents/notes/implemented/feature/2026-09-18-profile-wake-scheduler.md) — why this package stays separate from Schedule and what it deliberately does not wake.

-----

<a id="model-experience"></a>
## Model Experience

### Scheduled wake turn

#### What the model sees

Each fired interval queues one ordinary user-role message whose text is the configured `prompt` verbatim, tagged with `source: { kind: 'plugin', plugin: 'wake-scheduler' }`. The package adds no tool schema, no system-prompt section, and no other model-visible input.

#### Token effect

Each wake adds one data-dependent user message that remains in session history and contributes its tokens until ordinary compaction removes it. The plugin adds nothing to the request prefix.

#### KV Cache effect

The wake appends after existing history and preserves an already reusable prefix; only the appended message depends on the configured prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Live process only** — a wake fires only while the scheduled session is a live root agent of a running `dsh` process. A cold or unloaded session receives nothing, and no external channel exists.
- **Fixed interval, not calendar rules** — `intervalMinutes` is whole minutes and creation-anchored; Cron and weekday rules are not supported.
- **Broadcast default** — omitting `sessionId` schedules every root agent created after load, which is deliberate for a single-conversation profile and surprising for a multi-conversation one.
- **No delivery receipt** — a persisted cursor records that the follow-up was queued, not that the model answered or the person read it.
- **Host-side cursor** — the next-run state lives in storage, not in the session log, so reading cold history does not reveal the schedule and the cursor does not travel with a fork.
- **Narrow restart duplicate window** — a crash after the follow-up is queued but before the cursor is durable can repeat that one wake after restart.
- **Load-order boundary** — the plugin does not adopt agents that were already live when it loaded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions that are not decided. Waking a cold persisted session through `ctx.agents.resume` is the obvious next step for "schedule even when unloaded", but it needs an ownership and disposal answer for a scheduler-created agent that the Web host may later resume itself. No schedule or design owner yet.

</details>
