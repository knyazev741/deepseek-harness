import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserMessage } from '@knyazevai/dsh-llm'
import { WakeScheduler } from '../src/runtime.ts'
import type { WakeCursorTable } from '../src/runtime.ts'
import type { WakeCursor } from '../src/scheduling.ts'

const T0 = Date.parse('2026-09-18T00:00:00.000Z')
const INTERVAL = 30 * 60_000
const PROMPT = 'проверь фоновые задачи'
const SESSION = 'session-wake-spec'

/** In-memory cursor table; `failPut` models an unavailable durable medium. */
class MemoryCursors implements WakeCursorTable {
  readonly map = new Map<string, WakeCursor>()
  failPut = false
  /** Resolves the next `put`, so a test can dispose the scheduler mid-write. */
  gate: PromiseWithResolvers<undefined> | undefined

  get(key: string): WakeCursor | undefined {
    return this.map.get(key)
  }

  async put(key: string, value: WakeCursor): Promise<void> {
    if (this.failPut) throw new Error('cursor backend unavailable')
    await this.gate?.promise
    this.map.set(key, value)
  }
}

interface Target {
  readonly id: string
  followup(message: UserMessage): void
}

interface Harness {
  readonly scheduler: WakeScheduler<Target>
  readonly table: MemoryCursors
  readonly messages: UserMessage[]
  readonly infos: string[]
  readonly warns: string[]
  readonly target: Target
  live: boolean
  failFollowup: unknown
}

function harness(): Harness {
  const table = new MemoryCursors()
  const messages: UserMessage[] = []
  const infos: string[] = []
  const warns: string[] = []
  const state: Harness = {
    table,
    messages,
    infos,
    warns,
    live: true,
    failFollowup: undefined,
    target: {
      id: SESSION,
      followup(message: UserMessage): void {
        if (state.failFollowup !== undefined) throw state.failFollowup
        messages.push(message)
      },
    },
    scheduler: undefined as unknown as WakeScheduler<Target>,
  }
  state.scheduler = new WakeScheduler<Target>({
    cadence: { intervalMs: INTERVAL, startDelayMs: INTERVAL },
    prompt: PROMPT,
    table,
    logger: { info: (message) => { infos.push(message) }, warn: (message) => { warns.push(message) } },
    isLive: () => state.live,
    now: () => Date.now(),
  })
  return state
}

/** Join the text parts of one queued message. */
function textOf(message: UserMessage): string {
  return message.content.map(part => (part.type === 'text' ? part.text : '')).join('')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WakeScheduler', () => {
  it('initiates exactly one turn per elapsed interval', async () => {
    const h = harness()
    h.scheduler.arm(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(h.messages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(h.messages).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(2)
  })

  it('queues the configured prompt as a plugin-sourced user turn', async () => {
    const h = harness()
    h.scheduler.arm(h.target)
    await vi.advanceTimersByTimeAsync(INTERVAL)

    const message = h.messages[0]!
    expect(textOf(message)).toBe(PROMPT)
    expect(message.source.kind).toBe('plugin')
    expect(message.source).toMatchObject({ plugin: 'wake-scheduler' })
  })

  it('logs each activation with its session and run number', async () => {
    const h = harness()
    h.scheduler.arm(h.target)
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)

    expect(h.infos).toHaveLength(2)
    expect(h.infos[0]).toContain(SESSION)
    expect(h.infos[1]).toContain('turn 2')
    expect(h.table.get(SESSION)).toEqual({ lastRunAt: T0 + INTERVAL * 2, nextRunAt: T0 + INTERVAL * 3, runs: 2 })
  })

  it('honors a persisted future cursor instead of restarting the interval', async () => {
    const h = harness()
    h.table.map.set(SESSION, { lastRunAt: T0 - INTERVAL, nextRunAt: T0 + 60_000, runs: 7 })
    h.scheduler.arm(h.target)

    await vi.advanceTimersByTimeAsync(59_999)
    expect(h.messages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(h.messages).toHaveLength(1)
    expect(h.table.get(SESSION)?.runs).toBe(8)
  })

  it('collapses missed intervals into one catch-up wake', async () => {
    const h = harness()
    h.table.map.set(SESSION, { lastRunAt: T0 - INTERVAL * 8, nextRunAt: T0 - INTERVAL * 6, runs: 2 })
    h.scheduler.arm(h.target)

    await vi.advanceTimersByTimeAsync(0)
    expect(h.messages).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(2)
  })

  it('skips a target that is no longer live', async () => {
    const h = harness()
    h.live = false
    h.scheduler.arm(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(h.messages).toHaveLength(0)
    expect(h.table.get(SESSION)).toBeUndefined()
  })

  it('contains a follow-up failure and retries on the next interval', async () => {
    const h = harness()
    h.failFollowup = new Error('driver disposed')
    h.scheduler.arm(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(0)
    expect(h.warns[0]).toContain('driver disposed')
    expect(h.table.get(SESSION)).toBeUndefined()

    h.failFollowup = undefined
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(1)
  })

  it('renders a non-Error follow-up failure in its diagnostic', async () => {
    const h = harness()
    h.failFollowup = 'plain refusal'
    h.scheduler.arm(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.warns[0]).toContain('plain refusal')
  })

  it('does not re-arm when the scheduler is disposed during a failed follow-up', async () => {
    const h = harness()
    h.target.followup = () => {
      h.scheduler.dispose()
      throw new Error('disposed mid-fire')
    }
    h.scheduler.arm(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.warns).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(h.warns).toHaveLength(1)
    expect(h.messages).toHaveLength(0)
  })

  it('warns when the durable cursor cannot be written', async () => {
    const h = harness()
    h.table.failPut = true
    h.scheduler.arm(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(1)
    expect(h.warns[0]).toContain('cursor write failed')
  })

  it('disarms one target without touching another session', async () => {
    const h = harness()
    const other: Target = { id: 'session-other', followup: (message) => { h.messages.push(message) } }
    h.scheduler.arm(h.target)
    h.scheduler.arm(other)

    h.scheduler.disarm(SESSION)
    h.scheduler.disarm('session-absent')
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(h.messages).toHaveLength(1)
    expect(h.messages[0]!.source).toMatchObject({ kind: 'plugin' })
  })

  it('stops every armed wake on dispose and refuses later arming', async () => {
    const h = harness()
    h.scheduler.arm(h.target)
    h.scheduler.arm({ id: 'session-other', followup: (message) => { h.messages.push(message) } })
    h.scheduler.dispose()
    h.scheduler.arm(h.target)
    h.scheduler.disarm(SESSION)

    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(h.messages).toHaveLength(0)
  })

  it('does not re-arm a wake that was disposed while its cursor was written', async () => {
    const h = harness()
    h.table.gate = Promise.withResolvers<undefined>()
    h.scheduler.arm(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(1)
    h.scheduler.dispose()
    h.table.gate.resolve(undefined)

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(h.messages).toHaveLength(1)
  })
})
