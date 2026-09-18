import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@knyazevai/dsh-tools'
import type { UserMessage } from '@knyazevai/dsh-llm'
import { Config, apply, inject, name } from '../src/index.ts'
import type { WakeSchedule } from '../src/scheduling.ts'

const T0 = Date.parse('2026-09-18T00:00:00.000Z')
const INTERVAL = 30 * 60_000
const PROMPT = 'check the build'

/** Minimal agent stand-in: identity, queued messages, scoped effect owner, and its tool registry. */
interface FakeAgent {
  readonly id: string
  readonly messages: UserMessage[]
  followup(message: UserMessage): void
  readonly ctx: {
    effect: (setup: () => () => void, label: string) => void
    readonly tools: { register: (definition: ToolDefinition) => () => void }
  }
}

interface FakeContext {
  readonly ctx: Context
  readonly emitted: (agent: FakeAgent) => void
  readonly emittedChild: (agent: FakeAgent) => void
  readonly drop: (agent: FakeAgent) => void
  readonly dispose: () => void
  readonly disposeAgent: (agent: FakeAgent) => void
  readonly agent: (id: string) => FakeAgent
  readonly callTool: (agent: FakeAgent, name: string, args: unknown) => Promise<unknown>
  readonly stored: Map<string, WakeSchedule>
  readonly opens: unknown[]
  readonly closes: number
  readonly infos: string[]
  readonly warns: string[]
  /** Non-undefined value the next durable write throws, modelling an unavailable medium. */
  failPutThrown: unknown
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

function fakeContext(seed: ReadonlyArray<[string, WakeSchedule]> = []): FakeContext {
  const stored = new Map<string, WakeSchedule>(seed)
  const opens: unknown[] = []
  const infos: string[] = []
  const warns: string[] = []
  const agents = new Map<string, FakeAgent>()
  const roots: FakeAgent[] = []
  const created: Array<(payload: { agent: FakeAgent }) => void> = []
  const agentDisposers = new Map<string, Array<() => void>>()
  const lifecycles: Array<() => void> = []
  const toolsByAgent = new Map<string, Map<string, ToolDefinition>>()
  const state = { closes: 0, failPutThrown: undefined as unknown }

  const makeAgent = (id: string): FakeAgent => {
    const messages: UserMessage[] = []
    const tools = new Map<string, ToolDefinition>()
    toolsByAgent.set(id, tools)
    return {
      id,
      messages,
      followup: (message: UserMessage): void => { messages.push(message) },
      ctx: {
        effect: (setup: () => () => void): void => {
          const disposer = setup()
          const list = agentDisposers.get(id) ?? []
          list.push(disposer)
          agentDisposers.set(id, list)
        },
        tools: {
          register: (definition: ToolDefinition): (() => void) => {
            tools.set(definition.name, definition)
            return () => { tools.delete(definition.name) }
          },
        },
      },
    }
  }

  const register = (agent: FakeAgent, root: boolean): void => {
    agents.set(agent.id, agent)
    if (root) roots.push(agent)
    for (const handler of [...created]) handler({ agent })
  }

  const table = {
    get: (key: string) => stored.get(key),
    put: async (key: string, value: WakeSchedule) => {
      if (state.failPutThrown !== undefined) throw state.failPutThrown
      stored.set(key, value)
    },
  }

  const ctx = {
    agents: {
      get: (id: string) => agents.get(id),
      roots: () => [...roots],
    },
    logger: {
      info: (message: string) => { infos.push(message) },
      warn: (message: string) => { warns.push(message) },
    },
    storageDomain: {
      open: async (spec: unknown) => {
        opens.push(spec)
        return { table: () => table, close: async () => { state.closes += 1 } }
      },
    },
    effect: (setup: () => () => void): (() => void) => {
      const disposer = setup()
      lifecycles.push(disposer)
      return disposer
    },
    on: (event: string, handler: (payload: { agent: FakeAgent }) => void) => {
      expect(event).toBe('agent/created')
      created.push(handler)
      return () => { created.splice(created.indexOf(handler), 1) }
    },
  }

  return {
    ctx: ctx as unknown as Context,
    emitted: (agent: FakeAgent) => { register(agent, true) },
    emittedChild: (agent: FakeAgent) => { register(agent, false) },
    drop: (agent: FakeAgent) => {
      agents.delete(agent.id)
      roots.splice(roots.indexOf(agent), 1)
    },
    dispose: () => { for (const disposer of [...lifecycles]) disposer() },
    disposeAgent: (agent: FakeAgent) => { for (const disposer of agentDisposers.get(agent.id) ?? []) disposer() },
    agent: (id: string) => agents.get(id) ?? makeAgent(id),
    callTool: async (agent: FakeAgent, toolName: string, args: unknown) => {
      const definition = toolsByAgent.get(agent.id)?.get(toolName)
      if (definition === undefined) throw new Error(`agent ${agent.id} has no tool ${toolName}`)
      return definition.execute(args, { agent } as unknown as ToolRunContext)
    },
    stored,
    opens,
    get closes() { return state.closes },
    get failPutThrown() { return state.failPutThrown },
    set failPutThrown(value: unknown) { state.failPutThrown = value },
    infos,
    warns,
  }
}

/** Drain the microtasks an asynchronous seeding write owns. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
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

describe('wake-scheduler plugin shape', () => {
  it('exports the Loader-safe function-plugin namespace', () => {
    expect(name).toBe('wake-scheduler')
    expect(inject).toEqual(['agents', 'storageDomain', 'tools'])
  })

  it('defaults to a disabled profile fallback', () => {
    expect(Config({})).toEqual({ enabled: false })
  })
})

describe('wake-scheduler apply', () => {
  it('registers the tools without seeding any schedule while the fallback is disabled', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({}))

    const agent = h.agent('session-plug')
    h.emitted(agent)
    await settle()

    expect(h.stored.size).toBe(0)
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(agent.messages).toHaveLength(0)
    expect(await h.callTool(agent, 'wake_schedule_status', {})).toMatchObject({ status: 'none' })
  })

  it('seeds the profile fallback for a session with no durable record', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT }))
    expect(h.opens).toHaveLength(1)
    expect(h.opens[0]).toMatchObject({ name: 'wake_scheduler', version: 1 })

    const agent = h.agent('session-plug')
    h.emitted(agent)
    await settle()

    expect(h.stored.get('session-plug')).toMatchObject({
      status: 'active',
      source: 'config',
      prompt: PROMPT,
      nextRunAt: T0 + INTERVAL,
    })

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(agent.messages).toHaveLength(1)
    expect(textOf(agent.messages[0]!)).toBe(PROMPT)
  })

  it('fails loud on an enabled fallback with a missing or blank prompt', async () => {
    const h = fakeContext()
    await expect(apply(h.ctx, Config({ enabled: true, intervalMinutes: 30 })))
      .rejects.toThrow(/prompt must be non-empty/)
    await expect(apply(h.ctx, Config({ enabled: true, prompt: PROMPT })))
      .rejects.toThrow(/intervalMinutes is required/)
    expect(h.opens).toHaveLength(0)
  })

  it('applies the fallback only to the bound session', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT, sessionId: 'session-target' }))

    const other = h.agent('session-other')
    h.emitted(other)
    const target = h.agent('session-target')
    h.emitted(target)
    await settle()

    expect(h.stored.has('session-other')).toBe(false)
    expect(h.stored.has('session-target')).toBe(true)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(other.messages).toHaveLength(0)
    expect(target.messages).toHaveLength(1)
  })

  it('warns and arms nothing when the fallback cannot be stored', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT }))
    h.failPutThrown = new Error('schedule backend unavailable')

    const agent = h.agent('session-failing')
    h.emitted(agent)
    await settle()

    expect(h.stored.has('session-failing')).toBe(false)
    expect(h.warns[0]).toContain('schedule backend unavailable')
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(agent.messages).toHaveLength(0)
  })

  it('renders a non-Error fallback write failure in its diagnostic', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT }))
    h.failPutThrown = 'plain refusal'

    const agent = h.agent('session-failing')
    h.emitted(agent)
    await settle()

    expect(h.warns[0]).toContain('plain refusal')
  })

  it('lets a tool-set schedule override the profile fallback', async () => {
    const h = fakeContext([['session-plug', schedule({
      prompt: 'tool prompt',
      intervalMinutes: 30,
      nextRunAt: T0 + 60_000,
    })]])

    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 10, prompt: 'config prompt' }))
    const agent = h.agent('session-plug')
    h.emitted(agent)
    await settle()

    await vi.advanceTimersByTimeAsync(60_000 - 1)
    expect(agent.messages).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(agent.messages).toHaveLength(1)
    expect(textOf(agent.messages[0]!)).toBe('tool prompt')
    expect(h.stored.get('session-plug')?.source).toBe('tool')
  })

  it('lets a durable cancellation suppress the profile fallback', async () => {
    const h = fakeContext([['session-plug', schedule({ status: 'cancelled', nextRunAt: null })]])

    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: 'config prompt' }))
    const agent = h.agent('session-plug')
    h.emitted(agent)
    await settle()

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(agent.messages).toHaveLength(0)
    expect(h.stored.get('session-plug')?.status).toBe('cancelled')
  })

  it('re-arms immediately when the agent sets a schedule through the tool', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({}))
    const agent = h.agent('session-plug')
    h.emitted(agent)
    await settle()

    await h.callTool(agent, 'wake_schedule_set', { interval_minutes: 30, prompt: 'agent timer' })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(agent.messages).toHaveLength(1)
    expect(textOf(agent.messages[0]!)).toBe('agent timer')
  })

  it('stops the timer when the agent cancels through the tool', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({}))
    const agent = h.agent('session-plug')
    h.emitted(agent)
    await settle()

    await h.callTool(agent, 'wake_schedule_set', { interval_minutes: 30 })
    await h.callTool(agent, 'wake_schedule_cancel', {})
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(agent.messages).toHaveLength(0)
  })

  it('dispatches exactly one catch-up wake after a missed schedule survives a restart', async () => {
    const missed = schedule({ nextRunAt: T0 - INTERVAL * 6, runs: 2 })
    const before = fakeContext([['session-plug', missed]])
    await apply(before.ctx, Config({}))
    const first = before.agent('session-plug')
    before.emitted(first)
    await settle()

    // Model the process ending before the timer fires: the durable record keeps
    // its past target and the next process reads exactly that record back.
    before.dispose()
    const restarted = fakeContext([['session-plug', before.stored.get('session-plug')!]])
    await apply(restarted.ctx, Config({}))
    const second = restarted.agent('session-plug')
    restarted.emitted(second)
    await settle()

    await vi.advanceTimersByTimeAsync(0)
    expect(second.messages).toHaveLength(1)
    expect(restarted.stored.get('session-plug')).toMatchObject({
      runs: 3,
      skippedIntervals: 6,
      nextRunAt: T0 + INTERVAL,
    })
    expect(await restarted.callTool(second, 'wake_schedule_status', {})).toMatchObject({
      scheduled: true,
      runs: 3,
      skippedIntervals: 6,
      overdue: false,
    })

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(second.messages).toHaveLength(2)
  })

  it('skips a session that stopped being a live root before its wake fired', async () => {
    const h = fakeContext([['session-plug', schedule({ nextRunAt: T0 })]])
    await apply(h.ctx, Config({}))
    const agent = h.agent('session-plug')
    h.emitted(agent)
    await settle()

    h.drop(agent)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(agent.messages).toHaveLength(0)
    expect(h.stored.get('session-plug')?.runs).toBe(0)
  })

  it('never schedules a non-root agent', async () => {
    const h = fakeContext([['session-child', schedule()]])
    await apply(h.ctx, Config({}))

    const agent = h.agent('session-child')
    h.emittedChild(agent)
    await settle()

    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(agent.messages).toHaveLength(0)
  })

  it('cancels the wake and releases the domain on disposal', async () => {
    const h = fakeContext([['session-plug', schedule()]])
    await apply(h.ctx, Config({}))
    const agent = h.agent('session-plug')
    h.emitted(agent)
    await settle()

    h.disposeAgent(agent)
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(agent.messages).toHaveLength(0)

    h.dispose()
    expect(h.closes).toBe(1)
  })
})
