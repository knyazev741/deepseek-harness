import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import McpGateway from '../src/index.ts'
import * as McpGatewayInvariant from '../src/invariant.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'

describe('mcp-gateway invariant', () => {
  it('rejects duplicate lease ownership and incomplete teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(McpGateway, { allowlist: [] })
    await ctx.plugin(McpGatewayInvariant)

    const sessionId = 'invariant-session'
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/corruption', sessionId })
    expect(() => {
      ctx.emit('mcp-gateway/lease-created', { route: '/mcp/corruption', sessionId })
    }).toThrow(InvariantError)
    expect(() => {
      ctx.emit('mcp-gateway/teardown-complete')
    }).toThrow(InvariantError)
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/corruption', sessionId })
    ctx.emit('mcp-gateway/teardown-complete')
    await ctx.fiber.dispose()
  })

  it('tracks one terminal event for each gateway call', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(McpGatewayInvariant)
    const session = Session.create(SessionId('terminal-event'))
    const sessionId = String(session.id)
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/active', sessionId })
    ctx.emit('session/event', session, {
      type: 'external/tool-call',
      seq: 0,
      time: 1,
      data: { callId: 'call-1', name: 'allowed', arguments: {} },
    } as never)
    ctx.emit('mcp-gateway/call-started', { route: '/mcp/active', callId: 'call-1', sessionId })
    ctx.emit('session/event', session, {
      type: 'external/tool-result',
      seq: 0,
      time: 1,
      data: { callId: 'call-1', name: 'allowed', isError: true, error: { message: 'bounded' } },
    } as never)
    expect(() => {
      ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/active', callId: 'call-1', sessionId })
      ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/active', callId: 'call-1', sessionId })
    }).toThrow(InvariantError)
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/active', sessionId })
    await ctx.fiber.dispose()
  })

  it('requires a durable session result before accepting a gateway terminal event', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(McpGatewayInvariant)
    const session = Session.create(SessionId('durable-result'))
    const sessionId = String(session.id)
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/durable', sessionId })
    ctx.emit('session/event', session, {
      type: 'external/tool-call',
      seq: 0,
      time: 1,
      data: { callId: 'call-2', name: 'allowed', arguments: {} },
    } as never)
    ctx.emit('mcp-gateway/call-started', { route: '/mcp/durable', callId: 'call-2', sessionId })
    expect(() => {
      ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/durable', callId: 'call-2', sessionId })
    }).toThrow(InvariantError)
    ctx.emit('session/event', session, {
      type: 'external/tool-result',
      seq: 1,
      time: 2,
      data: { callId: 'call-2', name: 'allowed', isError: true, error: { message: 'bounded' } },
    } as never)
    ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/durable', callId: 'call-2', sessionId })
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/durable', sessionId })
    await ctx.fiber.dispose()
  })

  it('rejects a durable result when the authoritative durable call is missing', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(McpGatewayInvariant)
    const session = Session.create(SessionId('missing-call'))
    const sessionId = String(session.id)
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/missing-call', sessionId } as never)
    ctx.emit('mcp-gateway/call-started', { route: '/mcp/missing-call', callId: 'call-3', sessionId } as never)
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'external/tool-result',
        seq: 0,
        time: 1,
        data: { callId: 'call-3', name: 'allowed', isError: true, error: { message: 'bounded' } },
      } as never)
    }).toThrow(InvariantError)
    await ctx.fiber.dispose()
  })

  it('rejects an orphan durable result without gateway call state', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(McpGatewayInvariant)
    const session = Session.create(SessionId('orphan-result'))
    const sessionId = String(session.id)
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/orphan', sessionId })
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'external/tool-result',
        seq: 0,
        time: 1,
        data: { callId: 'orphan-call', name: 'allowed', isError: true, error: { message: 'bounded' } },
      } as never)
    }).toThrow(InvariantError)
    await ctx.fiber.dispose()
  })

  it('rejects a durable result emitted under another session for an existing call id', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(McpGatewayInvariant)
    const owner = Session.create(SessionId('owned-result'))
    const ownerId = String(owner.id)
    const wrongSession = Session.create(SessionId('wrong-result-session'))
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/owned', sessionId: ownerId })
    ctx.emit('session/event', owner, {
      type: 'external/tool-call',
      seq: 0,
      time: 1,
      data: { callId: 'owned-call', name: 'allowed', arguments: {} },
    } as never)
    ctx.emit('mcp-gateway/call-started', { route: '/mcp/owned', callId: 'owned-call', sessionId: ownerId })
    expect(() => {
      ctx.emit('session/event', wrongSession, {
        type: 'external/tool-result',
        seq: 0,
        time: 2,
        data: { callId: 'owned-call', name: 'allowed', isError: false, result: { ok: true } },
      } as never)
    }).toThrow(InvariantError)
    ctx.emit('session/event', owner, {
      type: 'external/tool-result',
      seq: 1,
      time: 3,
      data: { callId: 'owned-call', name: 'allowed', isError: false, result: { ok: true } },
    } as never)
    ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/owned', callId: 'owned-call', sessionId: ownerId })
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/owned', sessionId: ownerId })
    await ctx.fiber.dispose()
  })

  it('rejects a terminal event that names another live route', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(McpGatewayInvariant)
    const session = Session.create(SessionId('route-owner'))
    const sessionId = String(session.id)
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/route-a', sessionId })
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/route-b', sessionId })
    ctx.emit('session/event', session, {
      type: 'external/tool-call',
      seq: 0,
      time: 1,
      data: { callId: 'route-call', name: 'allowed', arguments: {} },
    } as never)
    ctx.emit('mcp-gateway/call-started', { route: '/mcp/route-a', callId: 'route-call', sessionId })
    ctx.emit('session/event', session, {
      type: 'external/tool-result',
      seq: 1,
      time: 2,
      data: { callId: 'route-call', name: 'allowed', isError: false, result: { ok: true } },
    } as never)
    expect(() => {
      ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/route-b', callId: 'route-call', sessionId })
    }).toThrow(InvariantError)
    ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/route-a', callId: 'route-call', sessionId })
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/route-a', sessionId })
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/route-b', sessionId })
    await ctx.fiber.dispose()
  })

  it('rejects teardown with an authoritative durable call that never entered the gateway', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(McpGatewayInvariant)
    const session = Session.create(SessionId('unannounced-call'))
    const sessionId = String(session.id)
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/unannounced', sessionId })
    ctx.emit('session/event', session, {
      type: 'external/tool-call',
      seq: 0,
      time: 1,
      data: { callId: 'call-4', name: 'allowed', arguments: {} },
    } as never)
    expect(() => {
      ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/unannounced', sessionId })
    }).toThrow(InvariantError)
    await ctx.fiber.dispose()
  })
})
