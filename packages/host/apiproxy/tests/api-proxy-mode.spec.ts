/**
 * The mode-aware session-create arms: creating a session in an external mode
 * yields a bare host session (no native Agent) whose durable header carries the
 * mode and whose `session.list` row surfaces it, while an unknown mode fails
 * loud and the external seam is optional (absent, an external mode still
 * fails loud). The native `dsh` path is unchanged by these edits and is covered
 * by the other api-proxy create suites.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent, type AgentFactory } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ExternalSessions, {
  ExternalProviderThreadId,
  ExternalTurnId,
  type ExternalBridgeContext,
  type ExternalModePreflightResult,
  type ExternalSessionProvider,
  type ExternalSessionStart,
} from '@deepseek-ai/dsh-external-session'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`mode-${String(nextRpc++)}`), payload }
}

class StubProvider implements ExternalSessionProvider {
  readonly modelDirectory = 'config'
  selected: { model: string; reasoningEffort?: string } | undefined
  preflightResult: ExternalModePreflightResult = { ok: true }
  preflightCalls = 0
  preflightGate: Promise<void> | undefined
  constructor(
    readonly provider: string,
    readonly label: string,
  ) {}
  async start(_request: ExternalSessionStart, _bridge: ExternalBridgeContext) {}
  async resume(_request: ExternalSessionStart, _bridge: ExternalBridgeContext, _providerThreadId: ExternalProviderThreadId) {}
  async preflight() {
    this.preflightCalls += 1
    await this.preflightGate
    return this.preflightResult
  }
  async prompt() { return { turnId: ExternalTurnId('t1') } }
  interrupt() {}
  async compact() {}
  async listModels() { return [] }
  async setModel(_sessionId: SessionId, model: string, reasoningEffort?: string) {
    this.selected = { model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
  }
  async dispose() {}
}

function harness({ external = true }: { external?: boolean } = {}): Promise<Context> {
  return (async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    if (external) {
      await ctx.plugin(ExternalSessions)
      ctx.externalSessions.registerProvider(new StubProvider('alpha', 'Alpha'))
    }
    ctx.apiProxy = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    return ctx
  })()
}

/** Install the smallest native factory needed to race native and external creates. */
function installNativeFactory(ctx: Context, resume: AgentFactory['resume'] = async () => {
  throw new Error('native test factory has no persisted sessions')
}): void {
  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx } as unknown as Agent
      const unregister = ctx.agents.register(agent)
      return { agent, dispose: async () => { unregister() } }
    },
    resume,
  }
  ctx.agents.setFactory(factory)
}

/** Publish the smallest resumed native Agent for identity/coalescing tests. */
function resumeNativeTestAgent(ctx: Context, sessionId: SessionId, cwd: string): ReturnType<AgentFactory['resume']> {
  const session = ctx.sessions.create(sessionId, { meta: { cwd } })
  const agent = { id: session.id, session, status: 'idle', ctx } as unknown as Agent
  const unregister = ctx.agents.register(agent)
  return Promise.resolve({ agent, dispose: async () => { unregister() } })
}

describe('session.create mode arms', () => {
  it('creates a bare external session with no native agent, surfacing mode', async () => {
    const ctx = await harness()
    const result = await ctx.apiProxy.sessions.create(request({
      sessionId: SessionId('e1'),
      cwd: '/tmp',
      mode: 'alpha',
    }))
    expect(result.result.ok).toBe(true)
    const session = ctx.sessions.get(SessionId('e1'))
    expect(session?.header.mode).toBe('alpha')
    // No native Agent was created for the external mode.
    expect(ctx.get('agents')?.get(SessionId('e1'))).toBeUndefined()
    const list = await ctx.apiProxy.sessions.list(request({}))
    expect(list.result.ok).toBe(true)
    const row = list.result.ok ? list.result.value.items.find(item => item.sessionId === SessionId('e1')) : undefined
    expect(row?.mode).toBe('alpha')
  })

  it('stamps an initial model on the external session header for the driver', async () => {
    const ctx = await harness()
    const result = await ctx.apiProxy.sessions.create(request({
      sessionId: SessionId('e1m'),
      cwd: '/tmp',
      mode: 'alpha',
      model: 'gpt-5',
    }))
    expect(result.result.ok).toBe(true)
    const session = ctx.sessions.get(SessionId('e1m'))
    expect(session?.header.mode).toBe('alpha')
    expect(session?.header.model).toBe('gpt-5')
  })

  it('allows an existing external idempotent create with the same mode and cwd', async () => {
    const ctx = await harness()
    const sessionId = SessionId('external-idempotent')
    const first = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    const second = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha', model: 'gpt-5' }))
    expect(first.result.ok).toBe(true)
    expect(second.result).toEqual({ ok: true, value: { sessionId } })
    expect(ctx.sessions.get(sessionId)?.header.model).toBeUndefined()
  })

  it('validates concurrent existing callers independently of the shared publication', async () => {
    const ctx = await harness()
    const sessionId = SessionId('external-concurrent-existing-cwd')
    const first = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    expect(first.result.ok).toBe(true)

    const wrong = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp/wrong', mode: 'alpha' }))
    const matching = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    const [wrongResult, matchingResult] = await Promise.all([wrong, matching])

    expect(wrongResult.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedCwd: '/tmp/wrong', existingCwd: '/tmp' } },
    })
    expect(matchingResult.result).toEqual({ ok: true, value: { sessionId } })
  })

  it('keeps a matching external retry alive when a concurrent native caller conflicts', async () => {
    const ctx = await harness()
    installNativeFactory(ctx)
    const sessionId = SessionId('external-concurrent-native-conflict')
    const first = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    expect(first.result.ok).toBe(true)

    const native = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp' }))
    const matching = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    const [nativeResult, matchingResult] = await Promise.all([native, matching])

    expect(nativeResult.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedMode: 'dsh', existingMode: 'alpha' } },
    })
    expect(matchingResult.result).toEqual({ ok: true, value: { sessionId } })
  })

  it('checks a cold native identity before external mode resume without a factory', async () => {
    const ctx = await harness()
    const sessionId = SessionId('cold-native-external-conflict')
    const meta = { version: 0, id: sessionId, createdAt: 1, cwd: '/tmp' }
    const inspect = vi.fn(async () => ({ meta, events: [] }))
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      inspect,
    } as never)

    const result = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))

    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedMode: 'alpha', existingMode: 'dsh' } },
    })
    expect(inspect).toHaveBeenCalledOnce()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
  })

  it('checks a cold native cwd before resuming and coalesces matching callers', async () => {
    const ctx = await harness()
    let resumes = 0
    installNativeFactory(ctx, async (_ownerCtx, options) => {
      resumes += 1
      return resumeNativeTestAgent(ctx, options.resumeSessionId, '/tmp')
    })
    const sessionId = SessionId('cold-native-cwd-conflict')
    const meta = { version: 0, id: sessionId, createdAt: 1, cwd: '/tmp' }
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    } as never)

    const wrong = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp/wrong' }))
    const matching = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp' }))
    const [wrongResult, matchingResult] = await Promise.all([wrong, matching])

    expect(wrongResult.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedCwd: '/tmp/wrong', existingCwd: '/tmp' } },
    })
    expect(matchingResult.result).toEqual({ ok: true, value: { sessionId } })
    expect(resumes).toBe(1)
  })


  it('resolves a matching retry before a later provider preflight failure', async () => {
    const ctx = await harness()
    const provider = ctx.externalSessions.getProvider('alpha') as StubProvider
    const sessionId = SessionId('external-preflight-retry')
    const first = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    expect(first.result.ok).toBe(true)
    provider.preflightResult = {
      ok: false,
      failure: { code: 'AUTH_UNAVAILABLE', message: 'Codex account is not authenticated.' },
    }

    const retry = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))

    expect(retry.result).toEqual({ ok: true, value: { sessionId } })
    expect(provider.preflightCalls).toBe(1)
  })

  it('reports an existing identity conflict before an unhealthy provider preflight', async () => {
    const ctx = await harness()
    const provider = ctx.externalSessions.getProvider('alpha') as StubProvider
    const sessionId = SessionId('external-conflict-before-preflight')
    ctx.sessions.create(sessionId, { meta: { cwd: '/tmp' } })
    provider.preflightResult = {
      ok: false,
      failure: { code: 'AUTH_UNAVAILABLE', message: 'Codex account is not authenticated.' },
    }

    const result = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))

    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedMode: 'alpha', existingMode: 'dsh' } },
    })
    expect(provider.preflightCalls).toBe(0)
  })

  it('coalesces concurrent external creates across a yielding persistence list', async () => {
    const ctx = await harness()
    const provider = ctx.externalSessions.getProvider('alpha') as StubProvider
    const sessionId = SessionId('external-concurrent-idempotent')
    let releaseList!: () => void
    const listReady = new Promise<void>((resolve) => { releaseList = resolve })
    const list = vi.fn(async () => {
      await listReady
      return []
    })
    ctx.provide('sessionPersistence', { list } as never)

    const first = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    const second = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    await Promise.resolve()
    releaseList()
    const results = await Promise.all([first, second])

    expect(results.every(result => result.result.ok)).toBe(true)
    expect(ctx.sessions.list().filter(session => session.id === sessionId)).toHaveLength(1)
    expect(list).toHaveBeenCalledOnce()
    expect(provider.preflightCalls).toBe(1)
  })

  it('returns a typed conflict for a concurrent external identity mismatch', async () => {
    const ctx = await harness()
    const alpha = ctx.externalSessions.getProvider('alpha') as StubProvider
    const beta = new StubProvider('beta', 'Beta')
    ctx.externalSessions.registerProvider(beta)
    let releaseBeta!: () => void
    const betaReady = new Promise<void>((resolve) => { releaseBeta = resolve })
    beta.preflightGate = betaReady
    const sessionId = SessionId('external-concurrent-conflict')

    const winner = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    const conflict = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'beta' }))
    const winnerResult = await winner
    releaseBeta()
    const conflictResult = await conflict

    expect(winnerResult.result.ok).toBe(true)
    expect(conflictResult.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedMode: 'beta', existingMode: 'alpha' } },
    })
    expect(alpha.preflightCalls).toBe(1)
    expect(beta.preflightCalls).toBe(0)
  })

  it('returns a typed cwd conflict for a concurrent external create', async () => {
    const ctx = await harness()
    const provider = ctx.externalSessions.getProvider('alpha') as StubProvider
    let releasePreflight!: () => void
    const preflightReady = new Promise<void>((resolve) => { releasePreflight = resolve })
    provider.preflightGate = preflightReady
    const sessionId = SessionId('external-concurrent-cwd-conflict')

    const winner = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    await Promise.resolve()
    const conflict = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp/other', mode: 'alpha' }))
    releasePreflight()
    const [winnerResult, conflictResult] = await Promise.all([winner, conflict])

    expect(winnerResult.result.ok).toBe(true)
    expect(conflictResult.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedCwd: '/tmp/other', existingCwd: '/tmp' } },
    })
    expect(provider.preflightCalls).toBe(1)
  })

  it('cleans a failed creation barrier so a later new id can retry', async () => {
    const ctx = await harness()
    const provider = ctx.externalSessions.getProvider('alpha') as StubProvider
    const sessionId = SessionId('external-failed-then-retry')
    provider.preflightResult = {
      ok: false,
      failure: { code: 'PREFLIGHT_FAILED', message: 'provider is starting' },
    }
    const first = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    expect(first.result.ok).toBe(false)
    provider.preflightResult = { ok: true }

    const retry = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))

    expect(retry.result).toEqual({ ok: true, value: { sessionId } })
    expect(ctx.sessions.get(sessionId)?.header.mode).toBe('alpha')
    expect(provider.preflightCalls).toBe(2)
  })

  it('rejects an external create when the existing id is native', async () => {
    const ctx = await harness()
    const sessionId = SessionId('external-native-conflict')
    ctx.sessions.create(sessionId, { meta: { cwd: '/tmp' } })
    const result = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedMode: 'alpha', existingMode: 'dsh' } },
    })
  })

  it('rejects an external create when the existing provider differs', async () => {
    const ctx = await harness()
    const sessionId = SessionId('external-provider-conflict')
    const first = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    expect(first.result.ok).toBe(true)
    ctx.externalSessions.registerProvider(new StubProvider('beta', 'Beta'))
    const result = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'beta' }))
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedMode: 'beta', existingMode: 'alpha' } },
    })
  })

  it('rejects an external create when the existing cwd differs', async () => {
    const ctx = await harness()
    const sessionId = SessionId('external-cwd-conflict')
    const first = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    expect(first.result.ok).toBe(true)
    const result = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp/other', mode: 'alpha' }))
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedCwd: '/tmp/other', existingCwd: '/tmp' } },
    })
  })

  it('rejects a native create when the existing id is externally driven', async () => {
    const ctx = await harness()
    const sessionId = SessionId('native-external-conflict')
    const first = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    expect(first.result.ok).toBe(true)
    const result = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp' }))
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedMode: 'dsh', existingMode: 'alpha' } },
    })
  })

  it('rejects a native create when the existing cwd differs', async () => {
    const ctx = await harness()
    const sessionId = SessionId('native-cwd-conflict')
    ctx.sessions.create(sessionId, { meta: { cwd: '/tmp' } })
    const result = await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp/other' }))
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedCwd: '/tmp/other', existingCwd: '/tmp' } },
    })
  })

  it('routes model and reasoning selection to a live external provider', async () => {
    const ctx = await harness()
    const provider = ctx.externalSessions.getProvider('alpha') as StubProvider
    const sessionId = SessionId('e1-select')
    const created = await ctx.apiProxy.sessions.create(request({
      sessionId,
      cwd: '/tmp',
      mode: 'alpha',
    }))
    expect(created.result.ok).toBe(true)
    await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })

    const result = await ctx.apiProxy.sessions.selectModel(request({
      sessionId,
      provider: 'alpha',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value.selected : undefined).toMatchObject({
      provider: 'alpha',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    })
    expect(provider.selected).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  })

  it('fails loud with unknown-mode when the provider is not registered', async () => {
    const ctx = await harness()
    const result = await ctx.apiProxy.sessions.create(request({
      sessionId: SessionId('e2'),
      cwd: '/tmp',
      mode: 'nope',
    }))
    expect(result.result.ok).toBe(false)
    expect(result.result.ok ? undefined : result.result.error?.code).toBe('unknown-mode')
    expect(ctx.sessions.get(SessionId('e2'))).toBeUndefined()
  })

  it('fails loud with unknown-mode when no external seam is composed', async () => {
    const ctx = await harness({ external: false })
    const result = await ctx.apiProxy.sessions.create(request({
      sessionId: SessionId('e3'),
      cwd: '/tmp',
      mode: 'alpha',
    }))
    expect(result.result.ok).toBe(false)
    expect(result.result.ok ? undefined : result.result.error?.code).toBe('unknown-mode')
    expect(ctx.sessions.get(SessionId('e3'))).toBeUndefined()
  })

  it('rechecks provider preflight before publishing and leaves no session on failure', async () => {
    const ctx = await harness()
    const provider = ctx.externalSessions.getProvider('alpha') as StubProvider
    provider.preflightResult = {
      ok: false,
      failure: { code: 'AUTH_UNAVAILABLE', message: 'Codex account is not authenticated.' },
    }
    const result = await ctx.apiProxy.sessions.create(request({
      sessionId: SessionId('preflight-failed'), cwd: '/tmp', mode: 'alpha',
    }))
    expect(result.result).toMatchObject({
      ok: false,
      error: {
        code: 'external-mode-unavailable',
        details: { mode: 'alpha', reason: 'AUTH_UNAVAILABLE' },
      },
    })
    expect(ctx.sessions.get(SessionId('preflight-failed'))).toBeUndefined()
  })

  it('lets a native caller materialize after an external preflight owner fails', async () => {
    const ctx = await harness()
    installNativeFactory(ctx)
    const provider = ctx.externalSessions.getProvider('alpha') as StubProvider
    provider.preflightResult = {
      ok: false,
      failure: { code: 'AUTH_UNAVAILABLE', message: 'Codex account is not authenticated.' },
    }
    let releasePreflight!: () => void
    provider.preflightGate = new Promise<void>((resolveGate) => { releasePreflight = resolveGate })
    const sessionId = SessionId('external-failed-native-retry')
    const external = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
    await vi.waitFor(() => { expect(provider.preflightCalls).toBe(1) })
    const native = ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp' }))
    releasePreflight()
    const [externalResult, nativeResult] = await Promise.all([external, native])

    expect(externalResult.result).toMatchObject({
      ok: false,
      error: { code: 'external-mode-unavailable', details: { mode: 'alpha', reason: 'AUTH_UNAVAILABLE' } },
    })
    expect(nativeResult.result).toEqual({ ok: true, value: { sessionId } })
    expect(ctx.agents.get(sessionId)).toBeDefined()
  })

  it('maps a bounded preflight timeout to no published external session', async () => {
    const ctx = await harness()
    const provider = ctx.externalSessions.getProvider('alpha') as StubProvider
    provider.preflightResult = {
      ok: false,
      failure: { code: 'PREFLIGHT_FAILED', message: 'Codex preflight timed out before the app-server became ready.' },
    }
    const result = await ctx.apiProxy.sessions.create(request({
      sessionId: SessionId('preflight-timeout'), cwd: '/tmp', mode: 'alpha',
    }))
    expect(result.result).toMatchObject({
      ok: false,
      error: {
        code: 'external-mode-unavailable',
        details: { mode: 'alpha', reason: 'PREFLIGHT_FAILED' },
      },
    })
    expect(ctx.sessions.get(SessionId('preflight-timeout'))).toBeUndefined()
  })
})
