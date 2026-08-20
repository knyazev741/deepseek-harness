/**
 * Real Loader composition for the gateway capability. The external fixture
 * provider supplies the same principal/recorder seam as a live external
 * session; only the Codex child is replaced by a keyless provider stub.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ExternalSessions, {
  ExternalTurnId,
  type ExternalBridgeContext,
  type ExternalSessionProvider,
} from '@deepseek-ai/dsh-external-session'
import McpGateway from '../src/index.ts'

const state: { bridge: ExternalBridgeContext | undefined } = { bridge: undefined }

const FixtureProviderPlugin = {
  name: 'mcp-gateway-fixture-provider',
  inject: ['externalSessions'],
  apply(ctx: Context): void {
    const provider: ExternalSessionProvider = {
      provider: 'mcp-fixture',
      label: 'MCP fixture',
      modelDirectory: 'config',
      async start(_request, bridge) { state.bridge = bridge },
      async resume(_request, bridge) { state.bridge = bridge },
      async prompt() { return { turnId: ExternalTurnId('fixture-turn') } },
      interrupt() {},
      async compact() {},
      async listModels() { return [] },
      async setModel() {},
      async dispose() {},
    }
    ctx.externalSessions.registerProvider(provider)
  },
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  state.bridge = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('mcp-gateway real Loader composition', () => {
  it('executes an allowlisted tool through approval and durable external records', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-mcp-gateway-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-user-approval'",
      "- name: '@deepseek-ai/dsh-external-session'",
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-mcp-gateway'",
      '  config:',
      '    allowlist: [allowed, hidden]',
      '- name: fixture:provider',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-user-approval', ApprovalService],
      ['@deepseek-ai/dsh-external-session', ExternalSessions],
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-mcp-gateway', McpGateway],
      ['fixture:provider', FixtureProviderPlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    context.on('tools/pre-execute', () => Promise.resolve({ kind: 'ask' as const }))
    context.on('approval/request-external', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    context.tools.register(defineContentToolFixture({
      name: 'allowed',
      description: 'loader allowed tool',
      parameters: {},
      externalEligibility: 'allow',
      async execute() { return [{ type: 'text' as const, text: 'loader-ok' }] },
    }))
    context.tools.register(defineContentToolFixture({
      name: 'hidden',
      description: 'loader hidden tool',
      parameters: {},
      async execute() { return [{ type: 'text' as const, text: 'hidden' }] },
    }))

    const session = context.sessions.create(SessionId('mcp-loader-session'))
    await context.externalSessions.start({
      sessionId: session.id,
      provider: 'mcp-fixture',
      cwd: process.cwd(),
      sandbox: 'read-only',
      approvalPolicy: 'ask',
    })
    const principal = state.bridge?.principal
    if (principal === undefined) throw new Error('Loader fixture did not receive an external principal')
    const lease = await context.mcpGateway.create({
      principal,
      tools: ['allowed', 'hidden'],
      signal: new AbortController().signal,
    })
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const client = new Client({ name: 'loader-gateway-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), {
      requestInit: { headers: { authorization: `Bearer ${lease.bearerToken}` } },
    }) as unknown as Parameters<McpClient['connect']>[0])
    await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: 'allowed' }] })
    await expect(client.callTool({ name: 'allowed', arguments: {} })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'loader-ok' }],
    })
    await expect(client.callTool({ name: 'hidden', arguments: {} })).rejects.toThrow()
    expect(session.events.map(event => event.type)).toEqual([
      'external/tool-call',
      'external/approval-asked',
      'external/approval-decided',
      'external/tool-result',
    ])
    await client.close()
    await lease[Symbol.asyncDispose]()
    await context.externalSessions.dispose(session.id)
  })
})
