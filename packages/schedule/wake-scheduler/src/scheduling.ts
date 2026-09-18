/**
 * Pure cadence arithmetic for the wake scheduler. Every decision is a
 * function of explicit arguments so restart behaviour is reproducible
 * without a clock, a timer, or a live agent.
 * @module @knyazevai/dsh-wake-scheduler/scheduling
 */

/** Smallest accepted wake interval; a shorter one would flood the conversation. */
export const MIN_INTERVAL_MINUTES = 1

/** Largest delay a Node timer represents before Node clamps it to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** One durable per-session cursor: the last wake and the next one. */
export interface WakeCursor {
  /** Epoch milliseconds of the last dispatched wake. */
  readonly lastRunAt: number
  /** Epoch milliseconds at which the next wake is due. */
  readonly nextRunAt: number
  /** Number of wakes dispatched for this session since the cursor was created. */
  readonly runs: number
}

/** Resolved interval and first-wake offset for one scheduler instance. */
export interface WakeCadence {
  /** Whole milliseconds between wakes. */
  readonly intervalMs: number
  /** Whole milliseconds from arming to the first wake when no cursor is stored. */
  readonly startDelayMs: number
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
 * Resolve the instant the next wake is due.
 * A stored future target is honored as-is. A target at or before `now` — the
 * process was down, or the session was cold — fires once immediately: missed
 * intervals are collapsed into a single catch-up wake, never replayed.
 * @param cursor - Durable cursor, or undefined before the first wake.
 * @param cadence - Resolved interval and first-wake offset.
 * @param now - Current epoch milliseconds.
 * @returns the epoch milliseconds at which the next wake is due.
 */
export function nextWakeAt(cursor: WakeCursor | undefined, cadence: WakeCadence, now: number): number {
  if (cursor === undefined) return now + cadence.startDelayMs
  return cursor.nextRunAt > now ? cursor.nextRunAt : now
}

/**
 * Derive the cursor to persist after one dispatched wake.
 * @param previous - Cursor before this wake, or undefined for the first wake.
 * @param cadence - Resolved interval.
 * @param now - Decision time of this wake.
 * @returns the cursor recording this wake and the following target.
 */
export function advanceCursor(
  previous: WakeCursor | undefined,
  cadence: WakeCadence,
  now: number,
): WakeCursor {
  return {
    lastRunAt: now,
    nextRunAt: now + cadence.intervalMs,
    runs: (previous?.runs ?? 0) + 1,
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
