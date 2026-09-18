/**
 * Pure schedule arithmetic and model-facing views. Every decision is a
 * function of explicit arguments so restart behaviour is reproducible
 * without a clock, a timer, or a live agent.
 * @module @knyazevai/dsh-wake-scheduler/scheduling
 */

/** Smallest accepted wake interval; a shorter one would flood the conversation. */
export const MIN_INTERVAL_MINUTES = 1

/** Largest delay a Node timer represents before Node clamps it to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Prompt used when a set call supplies no text. */
export const DEFAULT_WAKE_PROMPT =
  'Scheduled wake-up. Continue the plan and report anything that needs my decision.'

/** One durable per-session schedule, whether set by the agent or seeded from profile config. */
export interface WakeSchedule {
  /** An active schedule fires; a cancelled one only suppresses the profile fallback. */
  readonly status: 'active' | 'cancelled'
  /** Whether the agent set this schedule through a tool or the profile seeded it. */
  readonly source: 'tool' | 'config'
  /** Text of the turn this schedule initiates. */
  readonly prompt: string
  /** Whole minutes between wakes. */
  readonly intervalMinutes: number
  /** Whole minutes from creation to the first wake. */
  readonly startDelayMinutes: number
  /** Epoch milliseconds of the last dispatched wake, or null before the first. */
  readonly lastRunAt: number | null
  /** Epoch milliseconds at which the next wake is due, or null once cancelled. */
  readonly nextRunAt: number | null
  /** Wakes dispatched since this schedule was set. */
  readonly runs: number
  /** Intervals collapsed by the most recent catch-up decision; 0 for an on-time wake. */
  readonly skippedIntervals: number
  /** Epoch milliseconds of the last durable write. */
  readonly updatedAt: number
}

/**
 * Resolve the stored interval in whole milliseconds.
 * @param schedule - Durable schedule carrying the minute count.
 * @returns the interval in whole milliseconds.
 */
export function intervalMsOf(schedule: WakeSchedule): number {
  return schedule.intervalMinutes * 60_000
}

/**
 * Validate a configured interval expressed in whole minutes.
 * @param intervalMinutes - Configured interval in minutes.
 * @returns the interval in whole milliseconds.
 * @throws RangeError when the value is not a whole number of at least {@link MIN_INTERVAL_MINUTES}.
 */
export function resolveIntervalMs(intervalMinutes: number): number {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES) {
    throw new RangeError(
      `wake-scheduler: interval must be a whole number of minutes >= ${MIN_INTERVAL_MINUTES}, got ${intervalMinutes}`,
    )
  }
  return intervalMinutes * 60_000
}

/**
 * Resolve the instant an active schedule is next due.
 * A stored target is honored as-is; the start delay applies only to a record
 * written without one.
 * @param schedule - Active durable schedule.
 * @param now - Current epoch milliseconds.
 * @returns the epoch milliseconds at which the next wake is due.
 */
export function planDueAt(schedule: WakeSchedule, now: number): number {
  return schedule.nextRunAt ?? now + schedule.startDelayMinutes * 60_000
}

/** A schedule that has fired: its next target is always present. */
export type AdvancedSchedule = WakeSchedule & { readonly nextRunAt: number }

/**
 * Derive the schedule to persist after one dispatched wake.
 * A due target at or before `now` — the process was down, or the session was
 * cold — is one catch-up wake: missed intervals collapse into
 * {@link WakeSchedule.skippedIntervals} and are never replayed.
 * @param schedule - Schedule that fired.
 * @param now - Decision time of this wake.
 * @returns the advanced schedule recording this wake and the following target.
 */
export function advanceSchedule(schedule: WakeSchedule, now: number): AdvancedSchedule {
  const due = planDueAt(schedule, now)
  const skipped = due < now ? Math.max(0, Math.floor((now - due) / intervalMsOf(schedule))) : 0
  return {
    ...schedule,
    lastRunAt: now,
    nextRunAt: now + intervalMsOf(schedule),
    runs: schedule.runs + 1,
    skippedIntervals: skipped,
    updatedAt: now,
  }
}

/**
 * Bound one armed timer segment so Node never clamps it to a shorter delay.
 * @param target - Due instant in epoch milliseconds.
 * @param now - Current epoch milliseconds.
 * @returns the non-negative delay for the next timer segment.
 */
export function timerSegmentMs(target: number, now: number): number {
  return Math.max(0, Math.min(target - now, MAX_TIMER_DELAY_MS))
}

/** Canonical model-facing status value for one session. */
export interface WakeStatusView {
  /** Whether an active schedule will fire. */
  readonly scheduled: boolean
  /** Stored status, or `none` when this session has no durable schedule. */
  readonly status: 'active' | 'cancelled' | 'none'
  /** Who owns the schedule, or null when none exists. */
  readonly source: 'tool' | 'config' | null
  /** Prompt the schedule would present, or null when none exists. */
  readonly prompt: string | null
  /** Whole minutes between wakes, or null when none exists. */
  readonly intervalMinutes: number | null
  /** UTC RFC 3339 instant of the next wake, or null. */
  readonly nextRunAt: string | null
  /** UTC RFC 3339 instant of the last wake, or null. */
  readonly lastRunAt: string | null
  /** Wakes dispatched since the schedule was set. */
  readonly runs: number
  /** Whether an active schedule is already due, so one catch-up wake is queued. */
  readonly overdue: boolean
  /** Intervals collapsed by the most recent catch-up decision. */
  readonly skippedIntervals: number
}

/** ISO instant for a stored epoch value. */
function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString()
}

/**
 * Project one durable schedule into the model-facing status value.
 * @param schedule - Durable schedule.
 * @param now - Current epoch milliseconds.
 * @returns the canonical status value.
 */
export function statusView(schedule: WakeSchedule, now: number): WakeStatusView {
  return {
    scheduled: schedule.status === 'active',
    status: schedule.status,
    source: schedule.source,
    prompt: schedule.prompt,
    intervalMinutes: schedule.intervalMinutes,
    nextRunAt: iso(schedule.nextRunAt),
    lastRunAt: iso(schedule.lastRunAt),
    runs: schedule.runs,
    overdue: schedule.status === 'active'
      && schedule.nextRunAt !== null
      && schedule.nextRunAt <= now,
    skippedIntervals: schedule.skippedIntervals,
  }
}

/**
 * Status value for a session with no durable schedule.
 * @returns the canonical empty status value.
 */
export function emptyStatusView(): WakeStatusView {
  return {
    scheduled: false,
    status: 'none',
    source: null,
    prompt: null,
    intervalMinutes: null,
    nextRunAt: null,
    lastRunAt: null,
    runs: 0,
    overdue: false,
    skippedIntervals: 0,
  }
}
