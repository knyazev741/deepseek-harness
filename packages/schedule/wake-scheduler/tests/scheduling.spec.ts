import { describe, expect, it } from 'vitest'
import {
  MAX_TIMER_DELAY_MS,
  MIN_INTERVAL_MINUTES,
  advanceCursor,
  nextWakeAt,
  resolveIntervalMs,
  timerSegmentMs,
} from '../src/scheduling.ts'
import type { WakeCadence, WakeCursor } from '../src/scheduling.ts'

const CADENCE: WakeCadence = { intervalMs: 30 * 60_000, startDelayMs: 30 * 60_000 }
const T0 = Date.parse('2026-09-18T00:00:00.000Z')

describe('resolveIntervalMs', () => {
  it('converts whole minutes to milliseconds', () => {
    expect(MIN_INTERVAL_MINUTES).toBe(1)
    expect(resolveIntervalMs(30)).toBe(1_800_000)
  })

  it('rejects a fractional, zero, or negative interval', () => {
    for (const invalid of [0.5, 0, -5]) {
      expect(() => resolveIntervalMs(invalid)).toThrow(/whole number of minutes/)
    }
  })
})

describe('nextWakeAt', () => {
  it('starts one start delay after arming when no cursor is stored', () => {
    expect(nextWakeAt(undefined, CADENCE, T0)).toBe(T0 + CADENCE.startDelayMs)
  })

  it('honors a stored future target instead of restarting the interval', () => {
    const cursor: WakeCursor = { lastRunAt: T0 - 60_000, nextRunAt: T0 + 120_000, runs: 3 }
    expect(nextWakeAt(cursor, CADENCE, T0)).toBe(T0 + 120_000)
  })

  it('fires once immediately when the stored target is already due', () => {
    const overdue: WakeCursor = { lastRunAt: T0 - 7_200_000, nextRunAt: T0 - 3_600_000, runs: 1 }
    expect(nextWakeAt(overdue, CADENCE, T0)).toBe(T0)
  })

  it('fires once immediately when the stored target is exactly now', () => {
    const exact: WakeCursor = { lastRunAt: T0 - 3_600_000, nextRunAt: T0, runs: 1 }
    expect(nextWakeAt(exact, CADENCE, T0)).toBe(T0)
  })
})

describe('advanceCursor', () => {
  it('records the wake and the following target', () => {
    expect(advanceCursor(undefined, CADENCE, T0)).toEqual({
      lastRunAt: T0,
      nextRunAt: T0 + CADENCE.intervalMs,
      runs: 1,
    })
  })

  it('increments the wake count of an existing cursor', () => {
    const previous: WakeCursor = { lastRunAt: T0 - 60_000, nextRunAt: T0, runs: 4 }
    expect(advanceCursor(previous, CADENCE, T0).runs).toBe(5)
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
