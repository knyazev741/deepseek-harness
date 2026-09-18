/**
 * Live timer owner for scheduled wake targets. The scheduler keeps one
 * disposable timer per live root agent; the durable schedule in the wake
 * domain is the only state a restart reads back.
 * @module @knyazevai/dsh-wake-scheduler/runtime
 */

import { createUserMessage } from '@knyazevai/dsh-llm'
import type { UserMessage } from '@knyazevai/dsh-llm'
import { advanceSchedule, intervalMsOf, planDueAt, timerSegmentMs } from './scheduling.ts'
import type { WakeSchedule } from './scheduling.ts'

/** Minimal agent surface the scheduler drives; a live root Agent satisfies it. */
export interface WakeTarget {
  /** Session identity that also keys the durable schedule. */
  readonly id: string
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: UserMessage): void
}

/** Durable per-session schedule storage; the wake domain table satisfies it. */
export interface WakeStore {
  /** @param sessionId - Session identity. @returns the stored schedule, or undefined. */
  get(sessionId: string): WakeSchedule | undefined
  /** @param sessionId - Session identity. @param schedule - Schedule to store durably. @returns resolution after durability. */
  put(sessionId: string, schedule: WakeSchedule): Promise<void>
}

/** Diagnostics surface; the Cordis logger satisfies it. */
export interface WakeLogger {
  /** @param message - Activation record. */
  info(message: string): void
  /** @param message - Contained failure record. */
  warn(message: string): void
}

/** Construction options for one {@link WakeScheduler}. */
export interface WakeSchedulerOptions<Target extends WakeTarget> {
  /** Durable schedule storage. */
  readonly store: WakeStore
  /** Diagnostics sink. */
  readonly logger: WakeLogger
  /** Whether an armed target still owns its session; a disposed target is skipped. */
  readonly isLive: (target: Target) => boolean
  /** Clock override for tests. @returns current epoch milliseconds. */
  readonly now?: () => number
}

/** Render an unknown thrown value for process-local diagnostics only. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * One process-local, disposable set of wake timers.
 * @typeParam Target - Live object the scheduler drives and tests liveness against.
 */
export class WakeScheduler<Target extends WakeTarget = WakeTarget> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number
  private disposed = false

  /** @param options - Store, liveness, and diagnostics. */
  constructor(private readonly options: WakeSchedulerOptions<Target>) {
    this.now = options.now ?? Date.now
  }

  /**
   * Arm or re-arm the next wake for one target from its durable schedule.
   * A missing or cancelled schedule cancels any armed timer instead.
   * @param target - Live target to schedule.
   */
  apply(target: Target): void {
    if (this.disposed) return
    const schedule = this.options.store.get(target.id)
    if (schedule === undefined || schedule.status !== 'active') {
      this.disarm(target.id)
      return
    }
    const now = this.now()
    this.scheduleAt(target, planDueAt(schedule, now), now)
  }

  /**
   * Cancel the armed wake for one target.
   * @param id - Session identity of the target.
   */
  disarm(id: string): void {
    const timer = this.timers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(id)
  }

  /** Cancel every armed wake. The durable schedules are left untouched. */
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** Replace the timer for one target with a segment ending at `due`; a disposed scheduler arms nothing. */
  private scheduleAt(target: Target, due: number, now: number): void {
    if (this.disposed) return
    this.disarm(target.id)
    this.timers.set(target.id, setTimeout(() => {
      this.timers.delete(target.id)
      void this.fire(target)
    }, timerSegmentMs(due, now)))
  }

  /**
   * Initiate exactly one turn for one target, record the advanced schedule,
   * and arm the next wake. A wrapped failure writes no schedule and starts no
   * private retry: the next attempt is one interval later, so a broken target
   * cannot spin.
   */
  private async fire(target: Target): Promise<void> {
    /* v8 ignore next -- dispose clears armed timers synchronously, so an entry that sees `disposed` is unreachable */
    if (this.disposed || !this.options.isLive(target)) return
    const schedule = this.options.store.get(target.id)
    if (schedule === undefined || schedule.status !== 'active') return
    const now = this.now()
    const next = advanceSchedule(schedule, now)
    try {
      target.followup(createUserMessage({
        content: [{ type: 'text', text: schedule.prompt }],
        source: { kind: 'plugin', plugin: 'wake-scheduler' },
      }))
    } catch (error: unknown) {
      this.options.logger.warn(
        `wake-scheduler: follow-up failed for session "${target.id}": ${renderThrown(error)}; next attempt in one interval`,
      )
      this.scheduleAt(target, now + intervalMsOf(schedule), now)
      return
    }
    this.options.logger.info(
      `wake-scheduler: initiated wake ${next.runs} for session "${target.id}"`
      + (next.skippedIntervals === 0
        ? ''
        : ` after skipping ${next.skippedIntervals} interval(s)`),
    )
    this.scheduleAt(target, next.nextRunAt, now)
    try {
      await this.options.store.put(target.id, next)
    } catch (error: unknown) {
      this.options.logger.warn(
        `wake-scheduler: schedule write failed for session "${target.id}": ${renderThrown(error)}`,
      )
    }
  }
}
