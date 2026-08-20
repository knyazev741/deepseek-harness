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

    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/corruption' })
    expect(() => {
      ctx.emit('mcp-gateway/lease-created', { route: '/mcp/corruption' })
    }).toThrow(InvariantError)
    expect(() => {
      ctx.emit('mcp-gateway/teardown-complete')
    }).toThrow(InvariantError)
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/corruption' })
    ctx.emit('mcp-gateway/teardown-complete')
    await ctx.fiber.dispose()
  })

  it('tracks one terminal event for each gateway call', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(McpGatewayInvariant)
    const session = Session.create(SessionId('terminal-event'))
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/active' })
    ctx.emit('mcp-gateway/call-started', { route: '/mcp/active', callId: 'call-1' })
    ctx.emit('session/event', session, {
      type: 'external/tool-result',
      seq: 0,
      time: 1,
      data: { callId: 'call-1', name: 'allowed', isError: true, error: { message: 'bounded' } },
    } as never)
    expect(() => {
      ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/active', callId: 'call-1' })
      ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/active', callId: 'call-1' })
    }).toThrow(InvariantError)
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/active' })
    await ctx.fiber.dispose()
  })

  it('requires a durable session result before accepting a gateway terminal event', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(McpGatewayInvariant)
    const session = Session.create(SessionId('durable-result'))
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/durable' })
    ctx.emit('session/event', session, {
      type: 'external/tool-call',
      seq: 0,
      time: 1,
      data: { callId: 'call-2', name: 'allowed', arguments: {} },
    } as never)
    ctx.emit('mcp-gateway/call-started', { route: '/mcp/durable', callId: 'call-2' })
    expect(() => {
      ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/durable', callId: 'call-2' })
    }).toThrow(InvariantError)
    ctx.emit('session/event', session, {
      type: 'external/tool-result',
      seq: 1,
      time: 2,
      data: { callId: 'call-2', name: 'allowed', isError: true, error: { message: 'bounded' } },
    } as never)
    ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/durable', callId: 'call-2' })
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/durable' })
    await ctx.fiber.dispose()
  })
})
