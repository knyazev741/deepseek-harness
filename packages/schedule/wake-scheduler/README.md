---
description: "Agent-set durable wake-up schedules: wake_schedule_set, wake_schedule_status, and wake_schedule_cancel start a periodic turn in the calling session, with an optional profile-configured fallback."
kind: "package-reference"
---

# @knyazevai/dsh-wake-scheduler

English | [中文](README.zh.md)

## Summary

Wake Scheduler lets the agent put its own conversation on a timer: it calls `wake_schedule_set` in that session, the harness starts one ordinary turn per interval with the agent's prompt even while nobody writes, and `wake_schedule_status` or `wake_schedule_cancel` inspects or stops it. It exists because background-job completion notices never wake an idle session — they queue and arrive with the next human message — so a promised periodic check fails whenever the conversation is quiet. A profile may seed a fallback, but an agent-set schedule wins and survives restarts.

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

Choose Wake Scheduler when a conversation must keep working on its own — a periodic check-in, a long watch, a scheduled review — and the session stays live in a running `dsh` process. Avoid it when the work must reach you outside the session, or when you need calendar or Cron rules: the interval is fixed and whole-minute.

### Install the overlay

The scheduler is inert until a profile mounts it; the agent-facing tools then exist in every root session created after load:

```sh
dsh web --patch apps/cli/config/examples/wake-scheduler/cordis.yml
```

```yaml
- insert:
    - id: wake-scheduler
      name: '@knyazevai/dsh-wake-scheduler'
      config:
        enabled: false
```

With `enabled: false` — the shipped default — the agent can still set its own schedule, but the profile seeds none.

### Let the agent set the schedule

Ask the agent to wake itself, and it calls `wake_schedule_set` in the current session; no session id is ever passed, because the tool acts on the session of the agent scope that owns it. A successful call returns the stored schedule, including its next due instant:

```json
{"scheduled":true,"status":"active","source":"tool","prompt":"check the build","intervalMinutes":30,"nextRunAt":"2026-09-18T00:30:00.000Z","lastRunAt":null,"runs":0,"overdue":false,"skippedIntervals":0}
```

The three tools are the complete interface: `wake_schedule_set` takes `interval_minutes` (required, whole minutes), an optional `prompt`, and an optional `start_delay_minutes` (defaults to the interval; `0` fires the first wake immediately). `wake_schedule_status` takes no arguments and reports the schedule, its next and last wake instants, how many wakes fired, whether one catch-up wake is currently queued, and how many intervals the last catch-up collapsed. `wake_schedule_cancel` takes no arguments, stops the session's schedule, and suppresses any profile fallback until a later set. Setting a schedule again replaces the previous one.

### Enable the profile fallback

A profile may seed the same kind of schedule for a session that has none yet, so a fresh conversation starts already periodic:

```yaml
- insert:
    - id: wake-scheduler
      name: '@knyazevai/dsh-wake-scheduler'
      config:
        enabled: true
        intervalMinutes: 30
        prompt: 'Scheduled check-in: continue the plan and report anything that needs my decision.'
        sessionId: session-...
```

An enabled fallback with a missing interval or blank prompt fails at plugin load. A record the agent set or cancelled always takes priority over the fallback, and the fallback never rewrites it.

### What happens across restarts and cold sessions

Every schedule is stored durably per session id, so it survives a harness restart and a session that was closed. If the target instant passed while the session was not open, the next load dispatches exactly one catch-up turn — never a backlog — and records how many intervals it collapsed, which `wake_schedule_status` reports as `skippedIntervals` with `overdue: true` until that turn runs. The schedule keeps its cadence from the moment of the catch-up.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Scope and composition

The plugin declares `inject = ['agents', 'storageDomain', 'tools']` and is a function plugin with `name` / `inject` / `Config` / `apply`. It installs the three tools in every live root agent's exclusive scope, so a tool call identifies its session through the scope rather than an argument: roots already live when it loads are adopted, the `agent/created` observation is registered before the durable store opens, and a session published while that open is pending is adopted as soon as it resolves. Installation is idempotent per agent, so a repeated event cannot duplicate tools or timers. Subagents are never scheduled. Registration and arming are logged at `info` — `registered wake tools for session …`, `armed wake for session …`, and one `ready` line naming the adopted session count — so an operator can tell a plugin that never loaded from a session that never received tools.

### Where the turn comes from

A due wake calls `agent.followup(createUserMessage({ content, source: { kind: 'plugin', plugin: 'wake-scheduler' } }))`, the loop's ordinary follow-up boundary: it queues a normal user turn and wakes the driver, and it never steers or interrupts work already running. Nothing here creates a background job, appends a private session event type, or touches the job notification path.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: configuration, `agent/created` observation, fallback seeding, per-agent tool installation |
| [`src/tools.ts`](src/tools.ts) | The three agent-facing tools, their schemas, validation, and durable mutations |
| [`src/runtime.ts`](src/runtime.ts) | Live timer owner: arm from the stored schedule, one-turn dispatch, containment, disposal |
| [`src/scheduling.ts`](src/scheduling.ts) | Pure arithmetic and the canonical model-facing status view |
| [`src/persistence.ts`](src/persistence.ts) | The durable `wake_scheduler` domain and its strict record schema |

### Durable state

The `wake_scheduler` domain (version 1, table `schedules`) holds one record per session id with its status, source, prompt, interval, start delay, last and next wake instants, run count, skip count, and write time. This is host-side operational state, not session history: no session event type is added and `SESSION_FORMAT_VERSION` is unchanged, so a build without this plugin still reads the log. A set or cancel returns only after the backend is durable.

### Failure containment

A follow-up that throws is contained: the run advances nothing, logs a `warn`, and retries one full interval later, so a broken target cannot spin. A schedule write failure is contained the same way; the delivered turn stands and the next interval continues. A target that is no longer that session's live root is skipped and its record is left overdue for the next load. Disposal clears every armed timer without deleting durable schedules.

### Why there is no `./invariant` companion

No invariant companion is published because the package reads no second observation that could diverge from the one it owns. Every mutation is one durable write on the domain table followed by one timer re-arm from that stored record, so there is no independent observation to assert, and the companion and its wiring are omitted rather than shipped empty.

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

### Wake-schedule tools

#### What the model sees

The model sees three schemas in every live root agent created after this plugin loads. `wake_schedule_set` takes `interval_minutes` (required whole minutes, at least 1), `prompt` (optional; a generic check-in is used when omitted), and `start_delay_minutes` (optional whole minutes, `0` fires immediately). `wake_schedule_status` and `wake_schedule_cancel` take no arguments. Every result is the canonical JSON status object or a closed error with code `invalid_interval`, `invalid_prompt`, `persistence_uncertain`, or `internal_error`.

#### Token effect

The three scoped schemas add a fixed request prefix while the plugin is installed. Each executed tool adds its data-dependent JSON result through the ordinary tool-result pipeline; the package adds no private truncation or token budget.

#### KV Cache effect

The schemas remain prefix-stable while their definitions and scope stay unchanged. Tool calls and results append to later history and preserve an already reusable prefix.

### Scheduled wake turn

#### What the model sees

Each fired interval queues one ordinary user-role message whose text is the schedule's prompt verbatim, tagged with `source: { kind: 'plugin', plugin: 'wake-scheduler' }`. The package adds no system-prompt section and no other model-visible input.

#### Token effect

Each wake adds one data-dependent user message that remains in session history and contributes its tokens until ordinary compaction removes it. The plugin adds nothing to the request prefix.

#### KV Cache effect

The wake appends after existing history and preserves an already reusable prefix; only the appended message depends on the stored prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Live process only** — a wake fires only while the scheduled session is a live root agent of a running `dsh` process; a cold session gets its one catch-up turn only when it is loaded again. No external channel exists.
- **Fixed interval, not calendar rules** — `interval_minutes` is whole minutes and anchored when the schedule is set; Cron and weekday rules are not supported.
- **Tool catalog not harvested** — `pnpm run gen-tool-catalog` does not yet mount this package, so the generated catalog does not list these three schemas; the package README carries them.
- **No delivery receipt** — a persisted record shows that the follow-up was queued, not that the model answered or the person read it.
- **Host-side state** — the schedule lives in the wake domain, not in the session log, so reading cold history does not reveal it and it does not travel with a fork.
- **Narrow restart duplicate window** — a crash after the follow-up is queued but before the advanced record is durable can repeat that one wake after restart.
- **Root sessions only** — the tools are installed in root agent scopes; a subagent session never receives them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions that are not decided. Waking a cold persisted session through `ctx.agents.resume` is the obvious next step for "fire even when unloaded", but it needs an ownership and disposal answer for a scheduler-created agent that the Web host may later resume itself. Harvesting these schemas into the generated tool catalog is pending. Neither direction has a schedule or design owner.

</details>
