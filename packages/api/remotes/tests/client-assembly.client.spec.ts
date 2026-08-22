import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('api remotes Client assembly', () => {
  it('mounts and withdraws the fork workspace session state namespace', async () => {
    const mounted: string[] = []
    const disposed: string[] = []
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('remote', {
      async $mount(contribution: { readonly package: string }): Promise<() => Promise<void>> {
        mounted.push(contribution.package)
        return async () => { disposed.push(contribution.package) }
      },
    } as never)

    const dispose = await apply(ctx)

    expect(mounted).toContain('@deepseek-ai/dsh-fork-workspace-session-state')
    await dispose()
    expect(disposed).toEqual([...mounted].reverse())
  })
})
