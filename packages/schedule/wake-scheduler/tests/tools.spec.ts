import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@knyazevai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@knyazevai/dsh-tools'
import { DEFAULT_WAKE_PROMPT } from '../src/scheduling.ts'
import type { WakeSchedule } from '../src/scheduling.ts'
import type { WakeStore } from '../src/runtime.ts'
import { registerWakeTools } from '../src/tools.ts'

const T0 = Date.parse('2026-09-18T00:00:00.000Z')
const INTERVAL = 30 * 60_000
const SESSION = 'session-tools-spec'

/** In-memory schedule store; `failPut` models an unavailable durable medium. */
class MemoryStore implements WakeStore {
  readonly map = new Map<string, WakeSchedule>()
  failPut = false

  get(sessionId: string): WakeSchedule | undefined {
    return this.map.get(sessionId)
  }

  async put(sessionId: string, schedule: WakeSchedule): Promise<void> {
    if (this.failPut) throw new Error('schedule backend unavailable')
    this.map.set(sessionId, schedule)
  }
}

interface Harness {
  readonly definitions: Map<string, ToolDefinition>
  readonly disposed: string[]
  readonly store: MemoryStore
  readonly changes: number
  readonly agent: Agent
  readonly exec: ToolRunContext
  readonly call: (name: string, args: unknown) => Promise<unknown>
  readonly dispose: () => void
}

function harness(): Harness {
  const definitions = new Map<string, ToolDefinition>()
  const disposed: string[] = []
  const store = new MemoryStore()
  const agent = { id: SESSION } as unknown as Agent
  const state = { changes: 0 }
  const toolCtx = {
    tools: {
      register: (definition: ToolDefinition) => {
        definitions.set(definition.name, definition)
        return () => { disposed.push(definition.name) }
      },
    },
  } as unknown as Context

  const dispose = registerWakeTools(toolCtx, agent, {
    store,
    onScheduleChanged: () => { state.changes += 1 },
  })

  return {
    definitions,
    disposed,
    store,
    agent,
    exec: { agent } as unknown as ToolRunContext,
    get changes() { return state.changes },
    call: async (name: string, args: unknown) => {
      const definition = definitions.get(name)
      if (definition === undefined) throw new Error(`no registered tool ${name}`)
      return definition.execute(args, { agent } as unknown as ToolRunContext)
    },
    dispose,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('registerWakeTools', () => {
  it('registers exactly the three wake tools and disposes them once', () => {
    const h = harness()
    expect([...h.definitions.keys()].sort()).toEqual([
      'wake_schedule_cancel',
      'wake_schedule_set',
      'wake_schedule_status',
    ])

    h.dispose()
    h.dispose()
    expect(h.disposed).toHaveLength(3)
  })

  it('unwinds already-registered tools when a later registration fails', () => {
    const disposed: string[] = []
    let calls = 0
    const failing = {
      tools: {
        register: (definition: ToolDefinition) => {
          calls += 1
          if (calls === 3) throw new Error('registry rejected the tool')
          return () => { disposed.push(definition.name) }
        },
      },
    } as unknown as Context

    expect(() => registerWakeTools(failing, { id: SESSION } as unknown as Agent, {
      store: new MemoryStore(),
      onScheduleChanged: () => {},
    })).toThrow('registry rejected the tool')
    expect(disposed).toHaveLength(2)
  })
})

describe('wake_schedule_set', () => {
  it('stores a durable session schedule, re-arms, and reports it', async () => {
    const h = harness()
    const value = await h.call('wake_schedule_set', { interval_minutes: 30, prompt: 'check the build' })

    expect(h.store.get(SESSION)).toEqual({
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
    })
    expect(h.changes).toBe(1)
    expect(value).toMatchObject({
      scheduled: true,
      status: 'active',
      source: 'tool',
      prompt: 'check the build',
      nextRunAt: new Date(T0 + INTERVAL).toISOString(),
      overdue: false,
    })
  })

  it('uses the default prompt when none is supplied', async () => {
    const h = harness()
    await h.call('wake_schedule_set', { interval_minutes: 15 })
    expect(h.store.get(SESSION)?.prompt).toBe(DEFAULT_WAKE_PROMPT)
  })

  it('honors start_delay_minutes, including an immediate first wake', async () => {
    const h = harness()
    await h.call('wake_schedule_set', { interval_minutes: 30, start_delay_minutes: 0 })
    expect(h.store.get(SESSION)?.startDelayMinutes).toBe(0)
    expect(h.store.get(SESSION)?.nextRunAt).toBe(T0)
  })

  it('rejects an interval that is not a whole number of minutes', async () => {
    const h = harness()
    for (const interval of [0, -5, 1.5]) {
      expect(await h.call('wake_schedule_set', { interval_minutes: interval }))
        .toMatchObject({ code: 'invalid_interval' })
    }
    expect(h.store.map.size).toBe(0)
    expect(h.changes).toBe(0)
  })

  it('rejects a negative start delay and a blank prompt', async () => {
    const h = harness()
    expect(await h.call('wake_schedule_set', { interval_minutes: 30, start_delay_minutes: -1 }))
      .toMatchObject({ code: 'invalid_interval' })
    expect(await h.call('wake_schedule_set', { interval_minutes: 30, prompt: '   ' }))
      .toMatchObject({ code: 'invalid_prompt' })
    expect(h.changes).toBe(0)
  })

  it('rejects a call without the required interval through schema validation', async () => {
    const h = harness()
    await expect(h.call('wake_schedule_set', { prompt: 'x' })).rejects.toThrow()
    expect(h.changes).toBe(0)
  })

  it('reports uncertainty instead of claiming success when the write fails', async () => {
    const h = harness()
    h.store.failPut = true
    expect(await h.call('wake_schedule_set', { interval_minutes: 30 }))
      .toMatchObject({ code: 'persistence_uncertain' })
    expect(h.store.map.size).toBe(0)
    expect(h.changes).toBe(0)
  })
})

describe('wake_schedule_status', () => {
  it('reports no schedule for an untouched session', async () => {
    const h = harness()
    expect(await h.call('wake_schedule_status', {})).toMatchObject({
      scheduled: false,
      status: 'none',
      source: null,
      nextRunAt: null,
      overdue: false,
    })
  })

  it('reports the stored schedule and its overdue catch-up', async () => {
    const h = harness()
    h.store.map.set(SESSION, {
      status: 'active',
      source: 'tool',
      prompt: 'check',
      intervalMinutes: 30,
      startDelayMinutes: 30,
      lastRunAt: T0 - INTERVAL * 8,
      nextRunAt: T0 - INTERVAL * 6,
      runs: 4,
      skippedIntervals: 0,
      updatedAt: T0 - INTERVAL * 8,
    })
    expect(await h.call('wake_schedule_status', {})).toMatchObject({
      scheduled: true,
      status: 'active',
      runs: 4,
      overdue: true,
      nextRunAt: new Date(T0 - INTERVAL * 6).toISOString(),
    })
  })
})

describe('wake_schedule_cancel', () => {
  it('stores a durable cancellation that preserves the previous schedule facts', async () => {
    const h = harness()
    await h.call('wake_schedule_set', { interval_minutes: 30, prompt: 'check the build' })
    h.store.map.set(SESSION, { ...h.store.get(SESSION) as WakeSchedule, runs: 2, lastRunAt: T0 - INTERVAL })

    const value = await h.call('wake_schedule_cancel', {})
    expect(h.store.get(SESSION)).toMatchObject({
      status: 'cancelled',
      source: 'tool',
      prompt: 'check the build',
      intervalMinutes: 30,
      nextRunAt: null,
      runs: 2,
    })
    expect(h.changes).toBe(2)
    expect(value).toMatchObject({ scheduled: false, status: 'cancelled', overdue: false })
  })

  it('cancels a session that never had a schedule', async () => {
    const h = harness()
    expect(await h.call('wake_schedule_cancel', {})).toMatchObject({ status: 'cancelled' })
    expect(h.store.get(SESSION)).toMatchObject({ intervalMinutes: 0, nextRunAt: null, prompt: '' })
  })

  it('reports uncertainty when the cancellation cannot be stored', async () => {
    const h = harness()
    h.store.failPut = true
    expect(await h.call('wake_schedule_cancel', {}))
      .toMatchObject({ code: 'persistence_uncertain' })
    expect(h.changes).toBe(0)
  })
})

describe('wake tool scope', () => {
  it('rejects a caller that is not the owning agent', async () => {
    const h = harness()
    const foreign = { agent: { id: 'other' } } as unknown as ToolRunContext
    for (const name of ['wake_schedule_set', 'wake_schedule_status', 'wake_schedule_cancel']) {
      const definition = h.definitions.get(name)
      const args = name === 'wake_schedule_set' ? { interval_minutes: 30 } : {}
      expect(await definition?.execute(args, foreign)).toMatchObject({ code: 'internal_error' })
    }
    expect(h.store.map.size).toBe(0)
  })

  it('renders canonical JSON and a generic pending card', () => {
    const h = harness()
    const definition = h.definitions.get('wake_schedule_set')
    expect(definition?.output.render({}, { ok: true })).toEqual([{ type: 'text', text: '{"ok":true}' }])
    expect(definition?.presentCall?.({ interval_minutes: 30 })).toMatchObject({ card: 'generic', kind: 'other' })
    expect(h.definitions.get('wake_schedule_status')?.presentCall?.({})).toMatchObject({ kind: 'read' })
    expect(h.definitions.get('wake_schedule_cancel')?.presentCall?.({})).toMatchObject({ card: 'generic' })
  })
})
