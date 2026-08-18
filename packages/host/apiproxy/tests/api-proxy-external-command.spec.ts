/**
 * The per-session-mode command routing arms (`session.command`): an
 * external-mode session routes `/compact` to its provider's native compact
 * (recording `external/compaction-noticed`), `/model <id>` to `setModel`
 * (`external/model-switched`), and any other line — slash or plain — verbatim
 * as prompt text; a native-mode session rejects with `invalid-mode`. The
 * stub provider models the Codex provider's contract: those arms write the
 * durable events through the per-session bridge.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ExternalSessions, {
  ExternalTurnId,
  type ExternalBridgeContext,
  type ExternalSessionProvider,
  type ExternalSessionStart,
} from '@deepseek-ai/dsh-external-session'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`cmd-${String(nextRpc++)}`), payload }
}

/** Stub external provider recording command arms and writing durable events. */
class CommandProvider implements ExternalSessionProvider {
  readonly modelDirectory = 'config'
  lastBridge: ExternalBridgeContext | undefined
  readonly compacted = new Set<SessionId>()
  readonly switched: Array<{ sessionId: SessionId; model: string }> = []
  readonly prompts: string[] = []
  rejectModel = false

  constructor(
    readonly provider: string,
    readonly label: string,
  ) {}

  async start(_request: ExternalSessionStart, bridge: ExternalBridgeContext): Promise<void> {
    this.lastBridge = bridge
  }
  async prompt(sessionId: SessionId, text: string) {
    this.prompts.push(text)
    this.lastBridge!.appendEvent(sessionId, { type: 'external/message-added', data: { turnId: 't1', role: 'user', text } })
    return { turnId: ExternalTurnId('t1') }
  }
  interrupt() {}
  async compact(sessionId: SessionId) {
    this.compacted.add(sessionId)
    this.lastBridge!.appendEvent(sessionId, {
      type: 'external/compaction-noticed',
      data: { notice: 'The external agent compacted its conversation context.' },
    })
  }
  async listModels() { return [] }
  async setModel(sessionId: SessionId, model: string) {
    if (this.rejectModel) {
      throw new Error('external-session-codex: the Codex app-server 0.147.0 exposes no runtime model-switch on a live thread')
    }
    this.switched.push({ sessionId, model })
    this.lastBridge!.appendEvent(sessionId, { type: 'external/model-switched', data: { model } })
  }
  async dispose() {}
}

/** Keyless harness: external-session registry + a stub provider on `alpha`. */
async function harness(): Promise<{ ctx: Context; provider: CommandProvider }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ExternalSessions)
  const provider = new CommandProvider('alpha', 'Alpha')
  ctx.externalSessions.registerProvider(provider)
  ctx.apiProxy = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { ctx, provider }
}

let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/**
 * Create an external-mode session through the gateway, then start its provider
 * the way the external-session-bridge driver does on `session/created` (that
 * driver is not composed in this unit harness), so the session is live and the
 * routing arms dispatch to it.
 */
async function bootExternal(ctx: Context, sessionId: SessionId): Promise<void> {
  await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
  await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
}

describe('session.command external-mode routing', () => {
  it('routes /compact to the provider native compact and records the notice', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    const sessionId = SessionId('e1')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/compact' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toMatchObject({ kind: 'success' })
    expect(provider.compacted.has(sessionId)).toBe(true)
    const session = ctx.sessions.get(sessionId)!
    expect(session.events.map(event => event.type)).toContain('external/compaction-noticed')
  })

  it('routes /model <id> to setModel and records the switch event', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    const sessionId = SessionId('e2')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/model gpt-5' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toMatchObject({ kind: 'success' })
    expect(provider.switched).toEqual([{ sessionId, model: 'gpt-5' }])
    const session = ctx.sessions.get(sessionId)!
    expect(session.events.map(event => event.type)).toContain('external/model-switched')
  })

  it('rejects /model without an argument as an error outcome', async () => {
    const { ctx } = await harness()
    context = ctx
    const sessionId = SessionId('e3')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/model' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toEqual({ kind: 'error', text: 'Usage: /model <model-id>' })
  })

  it('surfaces a setModel rejection as an error outcome', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    provider.rejectModel = true
    const sessionId = SessionId('e4')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/model gpt-5' }))
    expect(result.result.ok).toBe(true)
    const value = result.result.ok ? result.result.value : undefined
    expect(value).toMatchObject({ kind: 'error' })
    if (value?.kind === 'error') expect(value.text).toContain('no runtime model-switch')
  })

  it('passes an unknown slash command through as prompt text', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    const sessionId = SessionId('e5')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/not-a-command arg' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toMatchObject({ kind: 'success' })
    expect(provider.prompts).toEqual(['/not-a-command arg'])
  })

  it('passes a plain non-slash line through as prompt text', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    const sessionId = SessionId('e6')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: 'hello there' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toMatchObject({ kind: 'success' })
    expect(provider.prompts).toEqual(['hello there'])
  })

  it('rejects a native-mode session with invalid-mode', async () => {
    const { ctx } = await harness()
    context = ctx
    const sessionId = SessionId('n1')
    // A native (no mode) session created directly; its lines route through the
    // agent-loop command registry, not the external per-mode boundary.
    ctx.sessions.create(sessionId, { meta: { cwd: '/tmp' } })

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/compact' }))
    expect(result.result.ok).toBe(false)
    expect(result.result.ok ? undefined : result.result.error?.code).toBe('invalid-mode')
  })

  it('rejects an unknown session with session-not-found', async () => {
    const { ctx } = await harness()
    context = ctx
    const result = await ctx.apiProxy.sessions.command(request({ sessionId: SessionId('missing'), line: '/compact' }))
    expect(result.result.ok).toBe(false)
    expect(result.result.ok ? undefined : result.result.error?.code).toBe('session-not-found')
  })
})
