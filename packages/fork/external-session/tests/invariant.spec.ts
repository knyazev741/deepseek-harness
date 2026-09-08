import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@knyazevai/dsh-invariants'
import * as ExternalSessionInvariant from '../src/invariant.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('fork external-session invariant companion', () => {
  it('owns and withdraws its empty companion registration', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(ExternalSessionInvariant)

    expect(() => {
      ctx.invariants.register('@knyazevai/dsh-fork-external-session', () => {})
    }).toThrow(/already registered/u)

    await fiber.dispose()
    await expect(ctx.plugin(ExternalSessionInvariant).await()).resolves.toBeDefined()
  })
})
