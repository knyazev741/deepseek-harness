import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
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
    ctx.emit('mcp-gateway/lease-created', { route: '/mcp/active' })
    ctx.emit('mcp-gateway/call-started', { route: '/mcp/active', callId: 'call-1' })
    expect(() => {
      ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/active', callId: 'call-1' })
      ctx.emit('mcp-gateway/call-terminal', { route: '/mcp/active', callId: 'call-1' })
    }).toThrow(InvariantError)
    ctx.emit('mcp-gateway/lease-disposed', { route: '/mcp/active' })
    await ctx.fiber.dispose()
  })
})
