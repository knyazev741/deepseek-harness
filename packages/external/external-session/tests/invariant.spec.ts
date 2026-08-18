/**
 * Tests for the external-session invariant companion: it accepts well-formed
 * provider registry transitions and rejects malformed descriptor formation,
 * duplicate adds, and removals of unknown providers.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ExternalAgentDescriptor } from '@deepseek-ai/dsh-external-session'
import ExternalSessions from '@deepseek-ai/dsh-external-session'
import * as ExternalSessionInvariant from '@deepseek-ai/dsh-external-session/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ExternalSessions)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ExternalSessionInvariant)
  return ctx
}

const descriptor = (overrides: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor => ({
  provider: 'mock',
  label: 'Mock',
  modelDirectory: 'provider',
  ...overrides,
})

describe('external-session invariants', () => {
  it('accepts well-formed provider registry transitions', async () => {
    const ctx = await setup()
    ctx.emit('external/provider-added', descriptor())
    ctx.emit('external/provider-removed', 'mock')
  })

  it('rejects malformed descriptor formation', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('external/provider-added', descriptor({ provider: '' })) })
      .toThrow(/names and labels must be non-empty/)
    expect(() => { ctx.emit('external/provider-added', descriptor({ label: '' })) })
      .toThrow(/names and labels must be non-empty/)
    expect(() => { ctx.emit('external/provider-added', descriptor({ modelDirectory: 'native' as never })) })
      .toThrow(/unknown modelDirectory/)
  })

  it('rejects repeated adds and removals of unknown providers', async () => {
    const ctx = await setup()
    const provider = descriptor()
    ctx.emit('external/provider-added', provider)
    expect(() => { ctx.emit('external/provider-added', provider) }).toThrow(/repeated "mock"/)
    expect(() => { ctx.emit('external/provider-removed', 'missing') }).toThrow(/unknown provider/)
  })
})
