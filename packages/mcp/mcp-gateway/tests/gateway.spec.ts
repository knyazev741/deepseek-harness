import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { ExternalToolPrincipalId, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import ExternalSessions, { ExternalTurnId, type ExternalSessionProvider } from '@deepseek-ai/dsh-external-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import McpGateway from '../src/index.ts'
import * as McpGatewayInvariant from '../src/invariant.ts'
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
  allowlist?: string[]
  beforeGateway?: (ctx: Context) => void
  invariant?: boolean
  maxRequestBytes?: number
  maxResponseBytes?: number
  executionTimeoutMs?: number
} = {}) {
  const ctx = new Context()
  if (options.invariant === true) await ctx.plugin(InvariantRegistry)
  if (options.approval === true) await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.approval === true) await ctx.plugin(ApprovalService)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  options.beforeGateway?.(ctx)
  if (options.invariant === true) await ctx.plugin(McpGatewayInvariant)
  await ctx.plugin(McpGateway, {
    allowlist: options.allowlist ?? ['allowed'],
    ...options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
    ...options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes },
    ...options.executionTimeoutMs === undefined ? {} : { executionTimeoutMs: options.executionTimeoutMs },
  })
  return ctx
}

async function chunkedPost(
  url: string,
  headers: Record<string, string>,
  chunks: readonly string[],
): Promise<{ status: number; body: string }> {
  const target = new URL(url)
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: 'POST',
      headers,
    }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (chunk: Buffer) => { parts.push(chunk) })
      res.once('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') })
      })
      res.once('error', reject)
    })
    req.once('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
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
  it('does not disclose disposal state when an unauthenticated request races teardown', async () => {
    const ctx = await setup()
    let entered!: () => void
    const routeEntered = new Promise<void>((resolve) => { entered = resolve })
    const register = ctx.webServer.register.bind(ctx.webServer)
    const registerSpy = vi.spyOn(ctx.webServer, 'register').mockImplementation(route => register({
      ...route,
      handler: (req, res) => {
        entered()
        return route.handler(req, res)
      },
    }))
    const lease = await ctx.mcpGateway.create({ principal: principal(), tools: [], signal: new AbortController().signal })
    const response = fetch(lease.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: 'Bearer wrong' },
      body: '{"malformed":true} trailing',
    })
    await routeEntered
    await lease[Symbol.asyncDispose]()
    expect((await response).status).toBe(401)
    registerSpy.mockRestore()
    await ctx.fiber.dispose()
  })

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
      accept: 'application/json, text/event-stream',
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

  it('serializes concurrent transport calls through one real recorder', async () => {
    const ctx = await setup({ approval: true })
    const owner = (await livePrincipal(ctx)).principal
    ctx.tools.register(defineContentToolFixture({
      name: 'allowed',
      description: 'concurrent fixture',
      parameters: {},
      externalEligibility: 'allow',
      async execute() {
        await new Promise(resolve => setTimeout(resolve, 5))
        return [{ type: 'text' as const, text: 'concurrent-ok' }]
      },
    }))
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-concurrent-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    await expect(Promise.all([
      client.callTool({ name: 'allowed', arguments: {} }),
      client.callTool({ name: 'allowed', arguments: {} }),
    ])).resolves.toHaveLength(2)
    expect(owner.session.events.filter(event => event.type === 'external/tool-call')).toHaveLength(2)
    expect(owner.session.events.filter(event => event.type === 'external/tool-result')).toHaveLength(2)
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
    const sessionBody = '[]'
    const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    await expect(fetch(lease.url, { method: 'POST', headers: { ...base, authorization: 'Bearer wrong' }, body }))
      .resolves.toMatchObject({ status: 401 })
    await expect(fetch(lease.url, {
      method: 'POST',
      headers: { ...base, authorization: `Bearer ${lease.bearerToken}`, 'mcp-session-id': 'not-owned' },
      body: sessionBody,
    })).resolves.toMatchObject({ status: 404 })
    await expect(fetch(lease.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.bearerToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
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
    const ctx = await setup({ approval: true, executionTimeoutMs: 20 })
    const owner = (await livePrincipal(ctx)).principal
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
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-timeout-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    await expect(client.callTool({ name: 'allowed', arguments: {} })).resolves.toMatchObject({ isError: true })
    await client.close()
    await lease[Symbol.asyncDispose]()
    expect(owner.session.events.filter(event => event.type === 'external/tool-call')).toHaveLength(1)
    expect(owner.session.events.filter(event => event.type === 'external/tool-result')).toHaveLength(1)
    await ctx.externalSessions.dispose(owner.session.id)
    await ctx.fiber.dispose()
  })

  it('disposes live leases with the gateway service fiber', async () => {
    const ctx = await setup()
    const owner = principal()
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: [], signal: new AbortController().signal })
    await ctx.fiber.dispose()
    await expect(fetch(lease.url)).rejects.toThrow()
  })

  it('returns Streamable HTTP JSON-RPC errors before consuming an invalid body', async () => {
    const ctx = await setup()
    const owner = principal()
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: [], signal: new AbortController().signal })
    const authorization = `Bearer ${lease.bearerToken}`
    const malformed = '{"jsonrpc":"2.0"} trailing'
    const missingAccept = await fetch(lease.url, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: malformed,
    })
    expect(missingAccept.status).toBe(406)
    expect(await missingAccept.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: null,
    })

    const invalidContentType = await fetch(lease.url, {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json, text/event-stream',
        'content-type': 'text/plain',
      },
      body: malformed,
    })
    expect(invalidContentType.status).toBe(415)
    expect(await invalidContentType.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: null,
    })

    const unsupportedMethod = await fetch(lease.url, {
      method: 'PATCH',
      headers: { authorization },
    })
    expect(unsupportedMethod.status).toBe(405)
    expect(await unsupportedMethod.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: null,
    })
    const missingGetSession = await fetch(lease.url, {
      method: 'GET',
      headers: { authorization, accept: 'text/event-stream' },
    })
    expect(missingGetSession.status).toBe(400)
    expect(await missingGetSession.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: null,
    })

    const missingDeleteSession = await fetch(lease.url, {
      method: 'DELETE',
      headers: { authorization },
    })
    expect(missingDeleteSession.status).toBe(400)
    expect(await missingDeleteSession.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: null,
    })

    const malformedEnvelope = await fetch(lease.url, {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: malformed,
    })
    expect(malformedEnvelope.status).toBe(400)
    expect(await malformedEnvelope.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32700 },
      id: null,
    })

    const client = new Client({ name: 'gateway-protocol-test', version: '1.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization } },
    })
    await client.connect(transport as unknown as Parameters<Client['connect']>[0])
    const sessionId = transport.sessionId
    if (sessionId === undefined) throw new Error('protocol fixture did not establish a session')
    const unsupportedProtocol = await fetch(lease.url, {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2099-01-01',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(unsupportedProtocol.status).toBe(400)
    expect(await unsupportedProtocol.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: null,
    })
    await client.close()
    const missingSession = await fetch(lease.url, {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    expect(missingSession.status).toBe(400)
    expect(await missingSession.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
      id: null,
    })
    await lease[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
  })

  it('returns a deterministic response for chunked UTF-8 body overflow', async () => {
    const ctx = await setup({ maxRequestBytes: 8 })
    const owner = principal()
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: [], signal: new AbortController().signal })
    const response = await chunkedPost(lease.url, {
      authorization: `Bearer ${lease.bearerToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    }, ['{"a":"', '😀😀😀', '"}'])
    expect(response.status).toBe(413)
    expect(JSON.parse(response.body)).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: null,
    })
    await lease[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
  })

  it('bounds structured results and redacts thrown diagnostics before recording', async () => {
    const ctx = await setup({ maxResponseBytes: 512 })
    const records: unknown[] = []
    let throwDiagnostic = false
    const owner: ExternalToolPrincipal = {
      ...principal(),
      recorder: {
        recordCall: () => undefined,
        recordResult: (value) => { records.push(value) },
      },
    }
    ctx.tools.register({
      name: 'allowed',
      description: 'large output',
      parameters: { type: 'object', properties: {} },
      externalEligibility: 'allow',
      output: {
        schema: { type: 'object', properties: { payload: { type: 'string' } } },
        render: () => [{ type: 'text', text: 'large' }],
      },
      async execute() {
        if (throwDiagnostic) throw new Error('Bearer super-secret /Users/knyaz/private/config.toml')
        return { payload: '😀'.repeat(2_000) }
      },
    })
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-output-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    const result = await client.callTool({ name: 'allowed', arguments: {} })
    expect(result).toMatchObject({ isError: true })
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records[0])).not.toContain('😀'.repeat(100))

    records.length = 0
    throwDiagnostic = true
    const thrown = await client.callTool({ name: 'allowed', arguments: {} })
    expect(thrown).toMatchObject({ isError: true })
    expect(JSON.stringify(thrown)).not.toContain('super-secret')
    expect(JSON.stringify(thrown)).not.toContain('/Users/knyaz')
    expect(JSON.stringify(records[0])).not.toContain('super-secret')
    await client.close()
    await lease[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
  })

  it('recursively redacts structured success and error secrets and complete local paths in MCP and durable data', async () => {
    const ctx = await setup({ approval: true })
    const owner = (await livePrincipal(ctx)).principal
    let fail = false
    let observedArguments: unknown
    ctx.tools.register({
      name: 'allowed',
      description: 'structured redaction fixture',
      parameters: { type: 'object', properties: {} },
      externalEligibility: 'allow',
      output: {
        schema: { type: 'object', properties: { safe: { type: 'object' } } },
        render: () => [{ type: 'text', text: 'structured' }],
      },
      async execute(argumentsValue) {
        observedArguments = argumentsValue
        if (fail) {
          throw new Error(JSON.stringify({
            apiKeyValue: 'error-api-key',
            nested: { secretValue: 'error-password', tokenValue: 'error-token' },
            path: '/Users/knyaz/Application Support/private error.json',
            uncPath: String.raw`\\server\share\Application Support\private error.txt`,
          }))
        }
        return {
          safe: { answer: 42, key: 'preserve this benign key', label: 'preserve this structure' },
          apiKeyValue: 'success-api-key',
          nested: { secretValue: 'success-password', tokenValue: 'success-token' },
          path: '/Users/knyaz/Application Support/private success.json',
          uncPath: String.raw`\\server\share\Application Support\private success.txt`,
        }
      },
    })
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-structured-redaction-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    const callArguments = {
      apiKeyValue: 'call-api-key',
      nested: { secretValue: 'call-secret', tokenValue: 'call-token' },
      path: '/Users/knyaz/Application Support/call file.txt',
      uncPath: String.raw`\\server\share\Application Support\call file.txt`,
      safe: { key: 'keep this key' },
    }
    const success = await client.callTool({ name: 'allowed', arguments: callArguments })
    expect(observedArguments).toEqual(callArguments)
    const successJson = JSON.stringify(success)
    expect(successJson).toContain('uncPath')
    expect(successJson).toContain('preserve this structure')
    expect(successJson).toContain('preserve this benign key')
    for (const secret of [
      'success-api-key', 'success-password', 'success-token', 'Application Support/private success.json',
      String.raw`\\server\share\Application Support\private success.txt`,
      'Application Support\\private success.txt',
      'private success.txt',
      'call-api-key', 'call-secret', 'call-token', 'Application Support/call file.txt',
      String.raw`\\server\share\Application Support\call file.txt`, 'Application Support\\call file.txt',
      'call file.txt',
    ]) {
      expect(successJson).not.toContain(secret)
    }
    const firstCall = owner.session.events.find(event => event.type === 'external/tool-call')
    const firstDurable = JSON.stringify(firstCall)
    for (const secret of [
      'call-api-key', 'call-secret', 'call-token', 'Application Support/call file.txt',
      String.raw`\\server\share\Application Support\call file.txt`, 'Application Support\\call file.txt',
      'call file.txt',
    ]) {
      expect(firstDurable).not.toContain(secret)
    }

    fail = true
    const error = await client.callTool({ name: 'allowed', arguments: callArguments })
    const errorJson = JSON.stringify(error)
    expect(errorJson).toContain('uncPath')
    for (const secret of [
      'error-api-key', 'error-password', 'error-token', 'Application Support/private error.json',
      String.raw`\\server\share\Application Support\private error.txt`,
      'Application Support\\private error.txt',
      'private error.txt',
      'call-api-key', 'call-secret', 'call-token', 'Application Support/call file.txt',
      String.raw`\\server\share\Application Support\call file.txt`, 'Application Support\\call file.txt',
      'call file.txt',
    ]) {
      expect(errorJson).not.toContain(secret)
    }
    const durable = JSON.stringify(owner.session.events)
    expect(durable).toContain('uncPath')
    for (const secret of [
      'error-api-key', 'error-password', 'error-token', 'Application Support/private error.json',
      String.raw`\\server\share\Application Support\private error.txt`, 'Application Support\\private error.txt',
      'private error.txt',
      'call-api-key', 'call-secret', 'call-token', 'Application Support/call file.txt',
      String.raw`\\server\share\Application Support\call file.txt`, 'Application Support\\call file.txt',
      'call file.txt',
    ]) {
      expect(durable).not.toContain(secret)
    }
    await client.close()
    await lease[Symbol.asyncDispose]()
    await ctx.externalSessions.dispose(owner.session.id)
    await ctx.fiber.dispose()
  })

  it('pairs an exact near-limit tool name with one durable result and clean disposal', async () => {
    const name = 'n'.repeat(65_385)
    const ctx = await setup({ approval: true, allowlist: [name], invariant: true, maxRequestBytes: 70_000, maxResponseBytes: 512 })
    const owner = (await livePrincipal(ctx)).principal
    ctx.tools.register({
      name,
      description: 'near-limit fixture',
      parameters: { type: 'object', properties: {} },
      externalEligibility: 'allow',
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'near-limit' }] },
      async execute() { return 'x'.repeat(1_000) },
    })
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: [name], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-record-boundary-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    await expect(client.callTool({ name, arguments: {} })).resolves.toMatchObject({ isError: true })
    expect(owner.session.events.filter(event => event.type === 'external/tool-call')).toHaveLength(1)
    expect(owner.session.events.filter(event => event.type === 'external/tool-result')).toHaveLength(1)
    await client.close()
    await expect(ctx.externalSessions.dispose(owner.session.id)).resolves.toBeUndefined()
    await lease[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
  })

  it('rejects an oversized multibyte durable call before recording anything', async () => {
    const ctx = await setup({ approval: true, maxRequestBytes: 70_000 })
    const owner = (await livePrincipal(ctx)).principal
    const recordCall = vi.spyOn(owner.recorder, 'recordCall')
    ctx.tools.register({
      name: 'allowed',
      description: 'oversized-call fixture',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      externalEligibility: 'allow',
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'never runs' }] },
      async execute() { throw new Error('executor must not run') },
    })
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-call-admission-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    const value = '🙂'.repeat(17_000)
    const error: unknown = await client.callTool({ name: 'allowed', arguments: { value } })
      .catch((reason: unknown): unknown => reason)
    const errorText = error instanceof Error ? error.message : JSON.stringify(error) ?? ''
    expect(errorText).toMatch(/tool call|record/i)
    expect(errorText).not.toContain(value)
    expect(errorText.length).toBeLessThan(1_000)
    expect(recordCall).not.toHaveBeenCalled()
    expect(owner.session.events.filter(event => event.type === 'external/tool-call')).toHaveLength(0)
    expect(owner.session.events.filter(event => event.type === 'external/tool-result')).toHaveLength(0)
    await client.close().catch(() => {})
    await expect(lease[Symbol.asyncDispose]()).resolves.toBeUndefined()
    await expect(ctx.externalSessions.dispose(owner.session.id)).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('admits an exact multibyte durable call envelope and records one result', async () => {
    const ctx = await setup({ approval: true, invariant: true, maxRequestBytes: 70_000 })
    const owner = (await livePrincipal(ctx)).principal
    ctx.tools.register({
      name: 'allowed',
      description: 'exact-call-envelope fixture',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      externalEligibility: 'allow',
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'exact' }] },
      async execute() { return 'exact' },
    })
    const fixedCall = {
      callId: 'mcp-00000000-0000-0000-0000-000000000000',
      name: 'allowed',
      arguments: { value: '' },
    }
    const recordLimit = 64 * 1024
    let value = '🙂'
    while (Buffer.byteLength(JSON.stringify({ ...fixedCall, arguments: { value } }), 'utf8') < recordLimit) value += 'a'
    while (Buffer.byteLength(JSON.stringify({ ...fixedCall, arguments: { value } }), 'utf8') > recordLimit) value = value.slice(0, -1)
    expect(Buffer.byteLength(JSON.stringify({ ...fixedCall, arguments: { value } }), 'utf8')).toBe(recordLimit)
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-exact-call-envelope-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    await expect(client.callTool({ name: 'allowed', arguments: { value } })).resolves.toMatchObject({ content: [{ type: 'text', text: 'exact' }] })
    const callEvent = owner.session.events.find(event => event.type === 'external/tool-call')
    const resultEvent = owner.session.events.find(event => event.type === 'external/tool-result')
    expect(callEvent).toBeDefined()
    expect(resultEvent).toBeDefined()
    expect(Buffer.byteLength(JSON.stringify(callEvent?.data), 'utf8')).toBe(recordLimit)
    expect(Buffer.byteLength(JSON.stringify(resultEvent?.data), 'utf8')).toBeLessThanOrEqual(recordLimit)
    await client.close()
    await expect(lease[Symbol.asyncDispose]()).resolves.toBeUndefined()
    await expect(ctx.externalSessions.dispose(owner.session.id)).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('requires a response budget that can carry the fixed MCP fallback', async () => {
    const fallback = {
      content: [{ type: 'text', text: 'tool result exceeded the configured response limit' }],
      isError: true,
    }
    const minimum = Buffer.byteLength(JSON.stringify(fallback), 'utf8')
    await expect(setup({ maxResponseBytes: minimum - 1 })).rejects.toThrow(/maxResponseBytes/)
    const ctx = await setup({ maxResponseBytes: minimum })
    await ctx.fiber.dispose()
  })

  it('contains throwing call observers while preserving bounded terminalization and later listeners', async () => {
    const ctx = await setup({ approval: true })
    const owner = (await livePrincipal(ctx)).principal
    ctx.tools.register(defineContentToolFixture({
      name: 'allowed',
      description: 'observer containment fixture',
      parameters: {},
      externalEligibility: 'allow',
      async execute() { return [{ type: 'text' as const, text: 'observer-ok' }] },
    }))
    const later: string[] = []
    ctx.on('mcp-gateway/call-started', () => { throw new Error('started observer boom') })
    ctx.on('mcp-gateway/call-started', () => { later.push('started') })
    ctx.on('mcp-gateway/call-terminal', () => { throw new Error('terminal observer boom') })
    ctx.on('mcp-gateway/call-terminal', () => { later.push('terminal') })
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: new AbortController().signal })
    const client = new Client({ name: 'gateway-observer-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    await expect(client.callTool({ name: 'allowed', arguments: {} })).resolves.toMatchObject({ isError: true })
    expect(later).toEqual(['started', 'terminal'])
    expect(owner.session.events.filter(event => event.type === 'external/tool-call')).toHaveLength(1)
    expect(owner.session.events.filter(event => event.type === 'external/tool-result')).toHaveLength(1)
    await client.close()
    await lease[Symbol.asyncDispose]()
    await ctx.externalSessions.dispose(owner.session.id)
    await ctx.fiber.dispose()
  })

  it('contains throwing lease lifecycle observers and still completes disposal', async () => {
    const later: string[] = []
    const ctx = await setup({
      beforeGateway: (beforeGatewayCtx) => {
        beforeGatewayCtx.on('mcp-gateway/lease-created', () => { throw new Error('created observer boom') })
        beforeGatewayCtx.on('mcp-gateway/lease-created', () => { later.push('created') })
        beforeGatewayCtx.on('mcp-gateway/lease-disposed', () => { throw new Error('disposed observer boom') })
        beforeGatewayCtx.on('mcp-gateway/lease-disposed', () => { later.push('disposed') })
      },
    })
    const owner = principal()
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: [], signal: new AbortController().signal })
    await lease[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
    expect(later).toEqual(['created', 'disposed'])
  })

  it('records one terminal result when external-session disposal cancels a live call', async () => {
    const ctx = await setup({ approval: true })
    const owner = (await livePrincipal(ctx)).principal
    ctx.tools.register({
      name: 'allowed',
      description: 'waits for cancellation',
      parameters: { type: 'object', properties: {} },
      externalEligibility: 'allow',
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'cancelled' }] },
      async execute(_args, execution) {
        await new Promise<void>((resolve) => {
          if (execution.signal.aborted) resolve()
          else execution.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return 'cancelled'
      },
    })
    const recorderSignal = (owner.recorder as { readonly signal?: AbortSignal }).signal
    if (recorderSignal === undefined) throw new Error('fixture recorder has no disposal signal')
    const lease = await ctx.mcpGateway.create({ principal: owner, tools: ['allowed'], signal: recorderSignal })
    const client = new Client({ name: 'gateway-disposal-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<Client['connect']>[0])
    const call = client.callTool({ name: 'allowed', arguments: {} }).catch(() => undefined)
    await vi.waitFor(() => { expect(owner.session.events.some(event => event.type === 'external/tool-call')).toBe(true) })
    await ctx.externalSessions.dispose(owner.session.id)
    await call
    await vi.waitFor(() => { expect(owner.session.events.filter(event => event.type === 'external/tool-result')).toHaveLength(1) })
    expect(owner.session.events.filter(event => event.type === 'external/tool-call')).toHaveLength(1)
    await client.close().catch(() => {})
    await lease[Symbol.asyncDispose]()
    await ctx.fiber.dispose()
  })
})
