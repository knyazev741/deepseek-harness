import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@knyazevai/dsh-agent-loop-testkit'
import type { WakeSchedule } from '../src/scheduling.ts'
import * as wakeScheduler from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('wake-scheduler real composition', () => {
  it('activates and opens its durable store once every injected service exists', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)

    const opens: unknown[] = []
    let closes = 0
    const stored = new Map<string, WakeSchedule>()
    ctx.provide('storageDomain', {
      open: async (spec: unknown) => {
        opens.push(spec)
        return {
          table: () => ({
            get: (key: string) => stored.get(key),
            put: async (key: string, value: WakeSchedule) => { stored.set(key, value) },
          }),
          close: async () => { closes += 1 },
        }
      },
    } as unknown as Context['storageDomain'])

    await ctx.plugin(wakeScheduler, {})

    // An unsatisfied `inject` would leave `apply` unrun and the store unopened.
    expect(opens).toHaveLength(1)
    expect(opens[0]).toMatchObject({ name: 'wake_scheduler', version: 1 })
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('tools')).toBeDefined()

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    expect(closes).toBe(1)
  })

  it('stays inert until the durable store is provided', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)

    const opens: unknown[] = []
    const fiber = await ctx.plugin(wakeScheduler, {})
    expect(opens).toHaveLength(0)
    expect(fiber.state).not.toBe(2)

    ctx.provide('storageDomain', {
      open: async (spec: unknown) => {
        opens.push(spec)
        return { table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }
      },
    } as unknown as Context['storageDomain'])

    await fiber.await()
    expect(opens).toHaveLength(1)
  })
})
