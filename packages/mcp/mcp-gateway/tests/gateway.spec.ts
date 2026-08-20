import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { ExternalToolPrincipalId, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import ExternalSessions, { ExternalTurnId, type ExternalSessionProvider } from '@deepseek-ai/dsh-external-session'
import McpGateway from '../src/index.ts'
import type { ExternalToolPrincipal } from '@deepseek-ai/dsh-tools'

function principal(ctx?: Context): ExternalToolPrincipal {
  return {
    kind: 'external',
    id: ExternalToolPrincipalId(`principal-${randomUUID()}`),
    session: Session.create(SessionId(`session-${randomUUID()}`)),
    ctx: ctx ?? undefined as never,
    recorder: {
      recordCall: () => undefined,
      recordResult: () => undefined,
    },
  }
}

async function setup(options: {
  approval?: boolean
  maxRequestBytes?: number
  executionTimeoutMs?: number
} = {}) {
  const ctx = new Context()
  if (options.approval === true) await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.approval === true) await ctx.plugin(ApprovalService)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(McpGateway, {
    allowlist: ['allowed'],
    ...options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
    ...options.executionTimeoutMs === undefined ? {} : { executionTimeoutMs: options.executionTimeoutMs },
  })
  return ctx
}

async function livePrincipal(ctx: Context): Promise<{ principal: ExternalToolPrincipal; session: Session }> {
  await ctx.plugin(ExternalSessions)
  const session = ctx.sessions.create(SessionId(`gateway-${randomUUID()}`))
  let principal: ExternalToolPrincipal | undefined
  const provider: ExternalSessionProvider = {
    provider: 'gateway-fixture',
    label: 'Gateway fixture',
    modelDirectory: 'config',
    async start(_request, bridge) {
      principal = bridge.principal
    },
    async resume(_request, bridge) {
      principal = bridge.principal
    },
    async prompt() { return { turnId: ExternalTurnId('fixture-turn') } },
    interrupt() {},
    async compact() {},
    async listModels() { return [] },
    async setModel() {},
    async dispose() {},
  }
  ctx.externalSessions.registerProvider(provider)
  await ctx.externalSessions.start({
    sessionId: session.id,
    provider: provider.provider,
    cwd: process.cwd(),
    sandbox: 'read-only',
    approvalPolicy: 'ask',
  })
  if (principal === undefined) throw new Error('gateway fixture did not receive an external principal')
  return { principal, session }
}

describe('authenticated MCP gateway', () => {
  it('authenticates before parsing and lists/calls only opted-in tools', async () => {
    const ctx = await setup()
    let calls = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'allowed',
      description: 'an allowed tool',
      parameters: {},
      externalEligibility: 'allow',
      async execute() {
        calls += 1
        return [{ type: 'text' as const, text: 'ok' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'hidden',
      description: 'not externally eligible',
      parameters: {},
      async execute() {
        calls += 1
        return [{ type: 'text' as const, text: 'hidden' }]
      },
    }))

    const owner = principal()
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed', 'hidden'], signal: new AbortController().signal })
    expect(new URL(lease.url).hostname).toBe('127.0.0.1')
    expect(lease.url).not.toContain(String(owner.session.id))

    const unauthorized = await fetch(lease.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"jsonrpc":"2.0"} trailing',
    })
    expect(unauthorized.status).toBe(401)
    expect(calls).toBe(0)

    const client = new Client({ name: 'gateway-test', version: '1.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    })
    await client.connect(transport as unknown as Parameters<Client['connect']>[0])
    await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: 'allowed' }] })
    await expect(client.callTool({ name: 'allowed', arguments: {} })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    })
    await expect(client.callTool({ name: 'hidden', arguments: {} })).rejects.toThrow()
    expect(calls).toBe(1)
    await client.close()
    await lease[Symbol.asyncDispose]()
    await expect(fetch(lease.url)).resolves.toMatchObject({ status: 404 })
    await ctx.fiber.dispose()
  })

  it('rejects trailing JSON and aborts a call before dispatching an unlisted tool', async () => {
    const ctx = await setup()
    let calls = 0
    ctx.tools.register({
      name: 'allowed',
      description: 'allowed',
      parameters: { type: 'object', properties: {} },
      externalEligibility: 'allow',
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() {
        calls += 1
        return 'ok'
      },
    })
    const owner = principal()
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const headers = {
      authorization: `Bearer ${lease.bearerToken}`,
      'content-type': 'application/json',
    }
    const malformed = await fetch(lease.url, {
      method: 'POST',
      headers,
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"} {"trailing":true}',
    })
    expect(malformed.status).toBe(400)
    expect(calls).toBe(0)

    const unknown = await fetch(lease.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hidden', arguments: {} } }),
    })
    expect(unknown.status).toBeGreaterThanOrEqual(400)
    expect(calls).toBe(0)
    await lease[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
  })

  it('uses the external approval bracket and the real recorder around pipeline execution', async () => {
    const ctx = await setup({ approval: true })
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'ask' as const }))
    ctx.on('approval/request-external', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    ctx.tools.register(defineContentToolFixture({
      name: 'allowed',
      description: 'requires approval',
      parameters: {},
      externalEligibility: 'allow',
      async execute() {
        return [{ type: 'text' as const, text: 'approved' }]
      },
    }))
    const owner = (await livePrincipal(ctx)).principal
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-approval-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    await expect(client.callTool({ name: 'allowed', arguments: {} })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'approved' }],
    })
    expect(owner.session.events.map(event => event.type)).toEqual([
      'external/tool-call',
      'external/approval-asked',
      'external/approval-decided',
      'external/tool-result',
    ])
    await client.close()
    await lease[Symbol.asyncDispose]()
    await ctx.externalSessions.dispose(owner.session.id)
    await ctx.fiber.dispose()
  })

  it('rejects wrong credentials, mismatched sessions, invalid UTF-8, and oversized bodies before dispatch', async () => {
    const ctx = await setup({ maxRequestBytes: 16 })
    let calls = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'allowed',
      description: 'bounded',
      parameters: {},
      externalEligibility: 'allow',
      async execute() {
        calls += 1
        return [{ type: 'text' as const, text: 'ok' }]
      },
    }))
    const owner = principal()
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const base = { 'content-type': 'application/json' }
    await expect(fetch(lease.url, { method: 'POST', headers: { ...base, authorization: 'Bearer wrong' }, body }))
      .resolves.toMatchObject({ status: 401 })
    await expect(fetch(lease.url, {
      method: 'POST',
      headers: { ...base, authorization: `Bearer ${lease.bearerToken}`, 'mcp-session-id': 'not-owned' },
      body,
    })).resolves.toMatchObject({ status: 404 })
    await expect(fetch(lease.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.bearerToken}`, 'content-type': 'application/json' },
      body: new Uint8Array([0xc3, 0x28]),
    })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(lease.url, {
      method: 'POST',
      headers: { ...base, authorization: `Bearer ${lease.bearerToken}` },
      body,
    })).resolves.toMatchObject({ status: 413 })
    expect(calls).toBe(0)
    await lease[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
  })

  it('aborts a running pipeline call at the configured deadline', async () => {
    const ctx = await setup({ executionTimeoutMs: 20 })
    ctx.tools.register({
      name: 'allowed',
      description: 'slow',
      parameters: { type: 'object', properties: {} },
      externalEligibility: 'allow',
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'late' }] },
      async execute(_args, exec) {
        await new Promise<void>((resolve) => {
          if (exec.signal.aborted) resolve()
          else exec.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return 'late'
      },
    })
    const owner = principal()
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-timeout-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    await expect(client.callTool({ name: 'allowed', arguments: {} })).resolves.toMatchObject({ isError: true })
    await client.close()
    await lease[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
  })

  it('disposes live leases with the gateway service fiber', async () => {
    const ctx = await setup()
    const owner = principal()
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: [], signal: new AbortController().signal })
    await ctx.fiber.dispose()
    await expect(fetch(lease.url)).rejects.toThrow()
  })
})
