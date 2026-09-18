import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WAKE_PROMPT,
  MAX_TIMER_DELAY_MS,
  MIN_INTERVAL_MINUTES,
  advanceSchedule,
  emptyStatusView,
  intervalMsOf,
  planDueAt,
  resolveIntervalMs,
  statusView,
  timerSegmentMs,
} from '../src/scheduling.ts'
import type { WakeSchedule } from '../src/scheduling.ts'

const T0 = Date.parse('2026-09-18T00:00:00.000Z')
const INTERVAL = 30 * 60_000

/** One active tool schedule with overridable fields. */
function base(overrides: Partial<WakeSchedule> = {}): WakeSchedule {
  return {
    status: 'active',
    source: 'tool',
    prompt: 'check the build',
    intervalMinutes: 30,
    startDelayMinutes: 30,
    lastRunAt: null,
    nextRunAt: T0 + INTERVAL,
    runs: 0,
    skippedIntervals: 0,
    updatedAt: T0,
    ...overrides,
  }
}

describe('resolveIntervalMs', () => {
  it('converts whole minutes to milliseconds', () => {
    expect(MIN_INTERVAL_MINUTES).toBe(1)
    expect(resolveIntervalMs(30)).toBe(INTERVAL)
  })

  it('rejects a fractional, zero, or negative interval', () => {
    for (const invalid of [0.5, 0, -5]) {
      expect(() => resolveIntervalMs(invalid)).toThrow(/whole number of minutes/)
    }
  })
})

describe('intervalMsOf', () => {
  it('resolves the stored minute count to milliseconds', () => {
    expect(intervalMsOf(base({ intervalMinutes: 5 }))).toBe(5 * 60_000)
  })
})

describe('planDueAt', () => {
  it('honors the stored target', () => {
    expect(planDueAt(base(), T0)).toBe(T0 + INTERVAL)
  })

  it('falls back to the start delay when a record carries no target', () => {
    expect(planDueAt(base({ nextRunAt: null, startDelayMinutes: 5 }), T0)).toBe(T0 + 5 * 60_000)
  })
})

describe('advanceSchedule', () => {
  it('records an on-time wake and the following target', () => {
    const next = advanceSchedule(base(), T0 + INTERVAL)
    expect(next).toMatchObject({
      lastRunAt: T0 + INTERVAL,
      nextRunAt: T0 + INTERVAL * 2,
      runs: 1,
      skippedIntervals: 0,
      status: 'active',
      source: 'tool',
    })
  })

  it('collapses a missed run into one catch-up with a skip count', () => {
    const overdue = base({ nextRunAt: T0 - INTERVAL * 6, runs: 2 })
    const next = advanceSchedule(overdue, T0)
    expect(next.runs).toBe(3)
    expect(next.skippedIntervals).toBe(6)
    expect(next.nextRunAt).toBe(T0 + INTERVAL)
  })

  it('counts a target due exactly now as an on-time wake', () => {
    expect(advanceSchedule(base({ nextRunAt: T0 }), T0).skippedIntervals).toBe(0)
  })
})

describe('timerSegmentMs', () => {
  it('returns the remaining delay for a near target', () => {
    expect(timerSegmentMs(T0 + 1_000, T0)).toBe(1_000)
  })

  it('clamps a distant target to the largest timer delay', () => {
    expect(timerSegmentMs(T0 + MAX_TIMER_DELAY_MS * 2, T0)).toBe(MAX_TIMER_DELAY_MS)
  })

  it('never returns a negative delay for a past target', () => {
    expect(timerSegmentMs(T0 - 1_000, T0)).toBe(0)
  })
})

describe('statusView', () => {
  it('reports an active schedule with UTC instants and no overdue flag', () => {
    const view = statusView(base({ runs: 3, lastRunAt: T0 - INTERVAL }), T0)
    expect(view).toEqual({
      scheduled: true,
      status: 'active',
      source: 'tool',
      prompt: 'check the build',
      intervalMinutes: 30,
      nextRunAt: new Date(T0 + INTERVAL).toISOString(),
      lastRunAt: new Date(T0 - INTERVAL).toISOString(),
      runs: 3,
      overdue: false,
      skippedIntervals: 0,
    })
  })

  it('marks a due target as an overdue catch-up', () => {
    const view = statusView(base({ nextRunAt: T0 - 1 }), T0)
    expect(view.overdue).toBe(true)
    expect(view.scheduled).toBe(true)
  })

  it('reports a cancelled schedule as unscheduled and never overdue', () => {
    const view = statusView(
      base({ status: 'cancelled', nextRunAt: null, prompt: '', intervalMinutes: 0 }),
      T0,
    )
    expect(view).toMatchObject({
      scheduled: false,
      status: 'cancelled',
      nextRunAt: null,
      overdue: false,
      source: 'tool',
    })
  })
})

describe('emptyStatusView', () => {
  it('describes a session with no schedule', () => {
    expect(emptyStatusView()).toEqual({
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
    })
    expect(DEFAULT_WAKE_PROMPT.length).toBeGreaterThan(0)
  })
})
