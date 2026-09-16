import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ExternalSessionRegistry from '../src/index.ts'

interface StubProvider {
  readonly id: string
}

declare module '../src/index.ts' {
  interface ExternalSessionModeMap {
    alpha: StubProvider
    beta: StubProvider
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('fork external-session registry', () => {
  it('accepts an empty registry as a valid composition', async () => {
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(ExternalSessionRegistry)).resolves.toBeDefined()
  })

  it('registers and looks up a merge-extensible provider by mode', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ExternalSessionRegistry)
    const provider: StubProvider = { id: 'alpha-provider' }

    ctx.externalSessions.register('alpha', provider)

    expect(ctx.externalSessions.lookup('alpha')).toBe(provider)
  })

  it('rejects duplicate mode ids before replacing the first provider', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ExternalSessionRegistry)
    const first: StubProvider = { id: 'first' }
    const second: StubProvider = { id: 'second' }
    ctx.externalSessions.register('alpha', first)

    expect(() => ctx.externalSessions.register('alpha', second)).toThrow(/already registered/u)
    expect(ctx.externalSessions.lookup('alpha')).toBe(first)
  })

  it('fails explicitly when a mode has no provider', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ExternalSessionRegistry)

    expect(() => ctx.externalSessions.lookup('beta')).toThrow(/not registered/u)
  })

  it('removes only the owned registration when its disposer runs', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ExternalSessionRegistry)
    const provider: StubProvider = { id: 'alpha-provider' }
    const dispose = ctx.externalSessions.register('alpha', provider)

    dispose()

    expect(() => ctx.externalSessions.lookup('alpha')).toThrow(/not registered/u)
  })

  it('does not let a stale disposer remove a replacement registration', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ExternalSessionRegistry)
    const first: StubProvider = { id: 'first' }
    const second: StubProvider = { id: 'second' }
    const disposeFirst = ctx.externalSessions.register('alpha', first)
    disposeFirst()
    ctx.externalSessions.register('alpha', second)

    disposeFirst()

    expect(ctx.externalSessions.lookup('alpha')).toBe(second)
  })

  it('unloads an injected provider with its fiber and allows it to be mounted again', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ExternalSessionRegistry)
    const provider: StubProvider = { id: 'hmr-provider' }
    const providerPlugin = {
      name: 'external-session-test-provider',
      inject: ['externalSessions'],
      apply(providerCtx: Context) {
        providerCtx.externalSessions.register('alpha', provider)
      },
    }

    const firstFiber = ctx.plugin(providerPlugin)
    await firstFiber
    expect(ctx.externalSessions.lookup('alpha')).toBe(provider)

    await firstFiber.dispose()
    expect(() => ctx.externalSessions.lookup('alpha')).toThrow(/not registered/u)

    const replacementFiber = ctx.plugin(providerPlugin)
    await replacementFiber
    expect(ctx.externalSessions.lookup('alpha')).toBe(provider)
    await replacementFiber.dispose()
  })
})
