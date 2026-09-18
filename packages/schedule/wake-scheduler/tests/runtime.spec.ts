import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserMessage } from '@knyazevai/dsh-llm'
import { WakeScheduler } from '../src/runtime.ts'
import type { WakeStore } from '../src/runtime.ts'
import type { WakeSchedule } from '../src/scheduling.ts'

const T0 = Date.parse('2026-09-18T00:00:00.000Z')
const INTERVAL = 30 * 60_000
const PROMPT = 'check the build'
const SESSION = 'session-wake-spec'

/** In-memory schedule store; `failPut` models an unavailable durable medium. */
class MemoryStore implements WakeStore {
  readonly map = new Map<string, WakeSchedule>()
  failPut = false
  /** Resolves the next `put`, so a test can dispose the scheduler mid-write. */
  gate: PromiseWithResolvers<undefined> | undefined

  get(sessionId: string): WakeSchedule | undefined {
    return this.map.get(sessionId)
  }

  async put(sessionId: string, schedule: WakeSchedule): Promise<void> {
    if (this.failPut) throw new Error('schedule backend unavailable')
    await this.gate?.promise
    this.map.set(sessionId, schedule)
  }
}

/** One active schedule with overridable fields. */
function schedule(overrides: Partial<WakeSchedule> = {}): WakeSchedule {
  return {
    status: 'active',
    source: 'tool',
    prompt: PROMPT,
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

interface Target {
  readonly id: string
  followup(message: UserMessage): void
}

interface Harness {
  readonly store: MemoryStore
  readonly messages: UserMessage[]
  readonly infos: string[]
  readonly warns: string[]
  readonly target: Target
  scheduler: WakeScheduler<Target>
  live: boolean
  failFollowup: unknown
}

function harness(seed: WakeSchedule | undefined = schedule()): Harness {
  const store = new MemoryStore()
  if (seed !== undefined) store.map.set(SESSION, seed)
  const messages: UserMessage[] = []
  const infos: string[] = []
  const warns: string[] = []
  const state: Harness = {
    store,
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
    store,
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
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(h.messages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(h.messages).toHaveLength(1)
    expect(textOf(h.messages[0]!)).toBe(PROMPT)
    expect(h.messages[0]!.source).toMatchObject({ kind: 'plugin', plugin: 'wake-scheduler' })
    expect(h.store.get(SESSION)).toMatchObject({
      lastRunAt: T0 + INTERVAL,
      nextRunAt: T0 + INTERVAL * 2,
      runs: 1,
      skippedIntervals: 0,
    })

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(2)
    expect(h.store.get(SESSION)?.runs).toBe(2)
  })

  it('collapses a missed backlog into exactly one catch-up wake', async () => {
    const h = harness(schedule({ nextRunAt: T0 - INTERVAL * 6, runs: 2 }))
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(0)
    expect(h.messages).toHaveLength(1)
    expect(h.store.get(SESSION)).toMatchObject({
      runs: 3,
      skippedIntervals: 6,
      nextRunAt: T0 + INTERVAL,
    })
    expect(h.infos.some(line => line.includes('after skipping 6 interval(s)'))).toBe(true)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(2)
  })

  it('never arms a cancelled schedule', async () => {
    const h = harness(schedule({ status: 'cancelled', nextRunAt: null }))
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(h.messages).toHaveLength(0)
  })

  it('logs the armed target and stays silent without a schedule', async () => {
    const h = harness()
    h.scheduler.apply(h.target)
    expect(h.infos).toHaveLength(1)
    expect(h.infos[0]).toContain('armed wake for session')
    expect(h.infos[0]).toContain(new Date(T0 + INTERVAL).toISOString())

    const quiet = harness()
    quiet.store.map.delete(SESSION)
    quiet.scheduler.apply(quiet.target)
    expect(quiet.infos).toHaveLength(0)
  })

  it('logs a disarm when an armed target loses its schedule', async () => {
    const h = harness()
    h.scheduler.apply(h.target)
    h.store.map.set(SESSION, schedule({ status: 'cancelled', nextRunAt: null }))
    h.scheduler.apply(h.target)

    expect(h.infos.some(line => line.includes('disarmed wake for session'))).toBe(true)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(0)
  })

  it('does nothing for a session with no schedule', async () => {
    const h = harness()
    h.store.map.delete(SESSION)
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(h.messages).toHaveLength(0)
  })

  it('skips a target that is no longer live', async () => {
    const h = harness()
    h.live = false
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(h.messages).toHaveLength(0)
    expect(h.store.get(SESSION)?.runs).toBe(0)
  })

  it('skips a schedule cancelled between arming and firing', async () => {
    const h = harness()
    h.scheduler.apply(h.target)
    h.store.map.set(SESSION, schedule({ status: 'cancelled', nextRunAt: null }))

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(0)
  })

  it('skips a schedule removed between arming and firing', async () => {
    const h = harness()
    h.scheduler.apply(h.target)
    h.store.map.delete(SESSION)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(0)
  })

  it('contains a follow-up failure and retries on the next interval', async () => {
    const h = harness()
    h.failFollowup = new Error('driver disposed')
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(0)
    expect(h.warns[0]).toContain('driver disposed')
    expect(h.store.get(SESSION)?.runs).toBe(0)

    h.failFollowup = undefined
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(1)
  })

  it('renders a non-Error follow-up failure in its diagnostic', async () => {
    const h = harness()
    h.failFollowup = 'plain refusal'
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.warns[0]).toContain('plain refusal')
  })

  it('warns when the advanced schedule cannot be written', async () => {
    const h = harness()
    h.store.failPut = true
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(1)
    expect(h.warns[0]).toContain('schedule write failed')
  })

  it('disarms one target without touching another session', async () => {
    const h = harness()
    const otherStoreEntry = schedule({ prompt: 'other' })
    h.store.map.set('session-other', otherStoreEntry)
    const otherMessages: UserMessage[] = []
    h.scheduler.apply(h.target)
    h.scheduler.apply({ id: 'session-other', followup: (message) => { otherMessages.push(message) } })

    h.scheduler.disarm(SESSION)
    h.scheduler.disarm('session-absent')
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(h.messages).toHaveLength(0)
    expect(otherMessages).toHaveLength(1)
  })

  it('stops every armed wake on dispose and refuses later arming', async () => {
    const h = harness()
    h.scheduler.apply(h.target)
    h.scheduler.dispose()
    h.scheduler.apply(h.target)
    h.scheduler.disarm(SESSION)

    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(h.messages).toHaveLength(0)
  })

  it('does not re-arm when the scheduler is disposed during a failed follow-up', async () => {
    const h = harness()
    h.target.followup = () => {
      h.scheduler.dispose()
      throw new Error('disposed mid-fire')
    }
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.warns).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(h.warns).toHaveLength(1)
    expect(h.messages).toHaveLength(0)
  })

  it('does not re-arm a wake that was disposed while its schedule was written', async () => {
    const h = harness()
    h.store.gate = Promise.withResolvers<undefined>()
    h.scheduler.apply(h.target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.messages).toHaveLength(1)
    h.scheduler.dispose()
    h.store.gate.resolve(undefined)

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(h.messages).toHaveLength(1)
  })
})
