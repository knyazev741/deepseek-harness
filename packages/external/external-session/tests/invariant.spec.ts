/**
 * Tests for the external-session invariant companion: it accepts well-formed
 * provider registry transitions and rejects malformed descriptor formation,
 * duplicate adds, and removals of unknown providers.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { ExternalAgentDescriptor } from '@deepseek-ai/dsh-external-session'
import ExternalSessions, { ExternalToolCallId } from '@deepseek-ai/dsh-external-session'
import * as ExternalSessionInvariant from '@deepseek-ai/dsh-external-session/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ExternalSessions)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ExternalSessionInvariant)
  return ctx
}

async function setupWithSessions(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
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

  it('enforces one durable external tool pair per session-owned call id', async () => {
    const ctx = await setupWithSessions()
    const session = ctx.sessions.create(SessionId('external-tool-invariant'))
    const call = {
      callId: ExternalToolCallId('invariant-call'),
      name: 'read',
      arguments: {},
    }
    expect(() => session.append('external/tool-call', {
      ...call,
      callId: ExternalToolCallId(''),
    })).toThrow(/callId must be non-empty/)
    expect(() => session.append('external/tool-call', {
      ...call,
      turnId: '',
    })).toThrow(/turnId must be non-empty/)

    session.append('external/tool-call', call)
    expect(() => session.append('external/tool-call', call)).toThrow(/repeated callId/)
    expect(() => session.append('external/tool-result', {
      callId: call.callId,
      name: 'write',
      isError: false,
      result: { ok: true },
    })).toThrow(/does not match external\/tool-call/)
    expect(() => session.append('external/tool-result', {
      callId: call.callId,
      name: 'read',
      isError: false,
      result: { ok: true },
      error: { message: 'also failed' },
    } as never)).toThrow(/exactly one result form/)

    session.append('external/tool-result', {
      callId: call.callId,
      name: 'read',
      isError: false,
      result: { ok: true },
    })
    expect(() => session.append('external/tool-result', {
      callId: call.callId,
      name: 'read',
      isError: false,
      result: { second: true },
    })).toThrow(/repeated callId/)
  })
})
