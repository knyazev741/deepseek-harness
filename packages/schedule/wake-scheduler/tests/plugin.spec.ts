import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@knyazevai/dsh-llm'
import { Config, apply, inject, name } from '../src/index.ts'
import type { WakeCursor } from '../src/scheduling.ts'

const T0 = Date.parse('2026-09-18T00:00:00.000Z')
const INTERVAL = 30 * 60_000
const PROMPT = 'проверь фоновые задачи'

/** Minimal agent stand-in: identity, one queued message, and its scoped effect owner. */
interface FakeAgent {
  readonly id: string
  readonly messages: UserMessage[]
  readonly ctx: { effect: (setup: () => () => void, label: string) => void }
  followup(message: UserMessage): void
}

interface FakeContext {
  readonly ctx: Context
  readonly emitted: (agent: FakeAgent) => void
  readonly emittedChild: (agent: FakeAgent) => void
  readonly dispose: () => void
  readonly disposeAgent: (agent: FakeAgent) => void
  readonly agent: (id: string) => FakeAgent
  readonly stored: Map<string, WakeCursor>
  readonly opens: unknown[]
  readonly closes: number
  readonly infos: string[]
  readonly warns: string[]
}

function fakeContext(): FakeContext {
  const stored = new Map<string, WakeCursor>()
  const opens: unknown[] = []
  const infos: string[] = []
  const warns: string[] = []
  const agents = new Map<string, FakeAgent>()
  const roots: FakeAgent[] = []
  const created: Array<(payload: { agent: FakeAgent }) => void> = []
  const agentDisposers = new Map<string, Array<() => void>>()
  const lifecycles: Array<() => void> = []
  const state = { closes: 0 }

  const makeAgent = (id: string): FakeAgent => {
    const messages: UserMessage[] = []
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
      },
    }
  }

  const agentsService = {
    get: (id: string) => agents.get(id),
    roots: () => [...roots],
  }

  const domain = {
    table: () => ({
      get: (key: string) => stored.get(key),
      put: async (key: string, value: WakeCursor) => { stored.set(key, value) },
    }),
    close: async () => { state.closes += 1 },
  }

  const ctx = {
    agents: agentsService,
    logger: {
      info: (message: string) => { infos.push(message) },
      warn: (message: string) => { warns.push(message) },
    },
    storageDomain: {
      open: async (spec: unknown) => { opens.push(spec); return domain },
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

  const register = (agent: FakeAgent, root: boolean): void => {
    agents.set(agent.id, agent)
    if (root) roots.push(agent)
    for (const handler of [...created]) handler({ agent })
  }

  const agentFor = (id: string): FakeAgent => {
    const existing = agents.get(id)
    if (existing !== undefined) return existing
    const createdAgent = makeAgent(id)
    agents.set(id, createdAgent)
    return createdAgent
  }

  return {
    ctx: ctx as unknown as Context,
    emitted: (agent: FakeAgent) => { register(agent, true) },
    emittedChild: (agent: FakeAgent) => { register(agent, false) },
    dispose: () => { for (const disposer of [...lifecycles]) disposer() },
    disposeAgent: (agent: FakeAgent) => { for (const disposer of agentDisposers.get(agent.id) ?? []) disposer() },
    agent: agentFor,
    stored,
    opens,
    get closes() { return state.closes },
    infos,
    warns,
  }
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
    expect(inject).toEqual(['agents', 'storageDomain'])
  })

  it('defaults to disabled in the validated configuration', () => {
    expect(Config({})).toEqual({ enabled: false })
  })
})

describe('wake-scheduler apply', () => {
  it('does nothing at all while disabled', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ intervalMinutes: 30, prompt: PROMPT }))

    expect(h.opens).toHaveLength(0)
    expect(h.stored.size).toBe(0)
  })

  it('fails loud when enabled without an interval', async () => {
    const h = fakeContext()
    await expect(apply(h.ctx, Config({ enabled: true, prompt: PROMPT })))
      .rejects.toThrow(/intervalMinutes is required/)
  })

  it('fails loud when enabled without prompt text', async () => {
    const h = fakeContext()
    await expect(apply(h.ctx, Config({ enabled: true, intervalMinutes: 30 })))
      .rejects.toThrow(/prompt must be non-empty/)
    await expect(apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: '   ' })))
      .rejects.toThrow(/prompt must be non-empty/)
  })

  it('honors startDelayMinutes for the first wake', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT, startDelayMinutes: 5 }))

    const agent = h.agent('session-delayed')
    h.emitted(agent)

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(agent.messages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(agent.messages).toHaveLength(1)
  })

  it('initiates exactly one turn per interval for a matching live root agent', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT }))
    expect(h.opens).toHaveLength(1)
    expect(h.opens[0]).toMatchObject({ name: 'wake_scheduler', version: 1 })

    const agent = h.agent('session-plug')
    h.emitted(agent)

    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(agent.messages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(agent.messages).toHaveLength(1)
    expect(agent.messages[0]!.source).toMatchObject({ kind: 'plugin', plugin: 'wake-scheduler' })
    expect(h.stored.get('session-plug')).toEqual({
      lastRunAt: T0 + INTERVAL,
      nextRunAt: T0 + INTERVAL * 2,
      runs: 1,
    })
    expect(h.infos[0]).toContain('session-plug')
  })

  it('honors the configured session binding', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT, sessionId: 'session-target' }))

    const other = h.agent('session-other')
    h.emitted(other)
    const target = h.agent('session-target')
    h.emitted(target)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(other.messages).toHaveLength(0)
    expect(target.messages).toHaveLength(1)
  })

  it('never schedules a non-root agent', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT }))

    const agent = h.agent('session-child')
    h.emittedChild(agent)

    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(agent.messages).toHaveLength(0)
  })

  it('cancels the wake when the agent scope is disposed', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT }))

    const agent = h.agent('session-gone')
    h.emitted(agent)
    h.disposeAgent(agent)

    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(agent.messages).toHaveLength(0)
  })

  it('releases the cursor domain when the plugin unmounts', async () => {
    const h = fakeContext()
    await apply(h.ctx, Config({ enabled: true, intervalMinutes: 30, prompt: PROMPT }))
    h.dispose()
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)

    expect(h.closes).toBe(1)
  })
})
