import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@knyazevai/dsh-invariants'
import * as WorkspaceSessionStateInvariant from '../src/invariant.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('fork workspace session state invariant companion', () => {
  it('owns and withdraws its registry contribution', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(WorkspaceSessionStateInvariant)

    expect(() => {
      ctx.invariants.register('@knyazevai/dsh-fork-workspace-session-state', () => {})
    }).toThrow(/already registered/u)

    await fiber.dispose()
    await expect(ctx.plugin(WorkspaceSessionStateInvariant).await()).resolves.toBeDefined()
  })
})
