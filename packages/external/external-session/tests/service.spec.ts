/**
 * Tests for the external-session service: the registry add/list/dispose
 * lifecycle (HMR-safety), typed failure on unknown provider and unknown
 * session, session-to-provider dispatch, the per-session bridge handed at
 * start (disposal signal, fail-closed permission channel, log append), and
 * model listing dispatch from both a native catalog and a config roster.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ExternalSessions, {
  ExternalToolCallId,
  ExternalProviderThreadId,
  parseExternalProviderThreadId,
  ExternalTurnId,
  type ExternalBridgeContext,
  type ExternalModelDirectory,
  type ExternalModelInfo,
  type ExternalSessionProvider,
  type ExternalSessionStart,
} from '@deepseek-ai/dsh-external-session'

class StubProvider implements ExternalSessionProvider {
  readonly modelDirectory: ExternalModelDirectory
  startCount = 0
  startError: Error | undefined
  startGate: Promise<void> | undefined
  lastStart: ExternalSessionStart | undefined
  lastBridge: ExternalBridgeContext | undefined
  readonly prompts: string[] = []
  readonly interrupted: SessionId[] = []
  readonly compacted: SessionId[] = []
  readonly switched: { sessionId: SessionId; model: string }[] = []
  readonly disposed: SessionId[] = []
  disposeGate: Promise<void> | undefined
  readonly disposeEntered = Promise.withResolvers<undefined>()
  readonly resumed: Array<{ sessionId: SessionId; providerThreadId: ExternalProviderThreadId }> = []
  resumeError: Error | undefined
  resumeGate: Promise<void> | undefined

  constructor(
    readonly provider: string,
    readonly label: string,
    modelDirectory: ExternalModelDirectory = 'provider',
    private readonly models: ExternalModelInfo[] = [],
  ) {
    this.modelDirectory = modelDirectory
  }

  async start(request: ExternalSessionStart, bridge: ExternalBridgeContext): Promise<void> {
    this.startCount += 1
    if (this.startError !== undefined) throw this.startError
    this.lastStart = request
    this.lastBridge = bridge
    await this.startGate
  }

  async resume(
    request: ExternalSessionStart,
    bridge: ExternalBridgeContext,
    providerThreadId: ExternalProviderThreadId,
  ): Promise<void> {
    if (this.resumeError !== undefined) throw this.resumeError
    this.resumed.push({ sessionId: request.sessionId, providerThreadId })
    this.lastStart = request
    this.lastBridge = bridge
    await this.resumeGate
  }

  async prompt(_sessionId: SessionId, text: string): Promise<{ turnId: ExternalTurnId }> {
    this.prompts.push(text)
    return { turnId: ExternalTurnId(`turn-${this.prompts.length}`) }
  }

  interrupt(sessionId: SessionId): void {
    this.interrupted.push(sessionId)
  }

  async compact(sessionId: SessionId): Promise<void> {
    this.compacted.push(sessionId)
  }

  async listModels(): Promise<ExternalModelInfo[]> {
    return this.models
  }

  async setModel(sessionId: SessionId, model: string): Promise<void> {
    this.switched.push({ sessionId, model })
  }

  async dispose(sessionId: SessionId): Promise<void> {
    this.disposed.push(sessionId)
    this.disposeEntered.resolve(undefined)
    await this.disposeGate
  }
}

async function setup(): Promise<{ ctx: Context; service: ExternalSessions }> {
  const ctx = new Context()
  await ctx.plugin(ExternalSessions)
  return { ctx, service: ctx.externalSessions }
}

describe('ExternalSessions registry', () => {
  it('brands and parses non-empty provider thread identities at the boundary', () => {
    const parsed = parseExternalProviderThreadId('opaque-thread-1')
    expect(parsed).toBe(ExternalProviderThreadId('opaque-thread-1'))
    expect(parseExternalProviderThreadId('')).toBeUndefined()
    expect(parseExternalProviderThreadId(42)).toBeUndefined()
  })

  it('registers, lists, lists agents, looks up, and removes providers', async () => {
    const { ctx, service } = await setup()
    const added: string[] = []
    const removed: string[] = []
    ctx.on('external/provider-added', descriptor => void added.push(descriptor.provider))
    ctx.on('external/provider-removed', name => void removed.push(name))
    const provider = new StubProvider('alpha', 'Alpha')

    const dispose = service.registerProvider(provider)
    expect(service.list()).toEqual(['alpha'])
    expect(service.getProvider('alpha')).toBe(provider)
    expect(service.listAgents()).toEqual([{ provider: 'alpha', label: 'Alpha', modelDirectory: 'provider' }])

    dispose()
    expect(added).toEqual(['alpha'])
    expect(removed).toEqual(['alpha'])
    expect(service.getProvider('alpha')).toBeUndefined()
    expect(service.listAgents()).toEqual([])
  })

  it('rejects a duplicate provider name with a typed error', async () => {
    const { service } = await setup()
    service.registerProvider(new StubProvider('dup', 'Dup'))
    expect(() => { service.registerProvider(new StubProvider('dup', 'Dup')) })
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_PROVIDER' }))
  })

  it('rejects unknown-provider start loud without handing a bridge', async () => {
    const { service } = await setup()
    await expect(service.start({ sessionId: SessionId('s1'), provider: 'missing', cwd: '/tmp' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' })
  })

  it('rejects unknown-provider model listing loud', async () => {
    const { service } = await setup()
    await expect(service.listModels('missing')).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' })
  })

  it('rejects a duplicate started session and unknown-session operations', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    service.registerProvider(provider)
    const sessionId = SessionId('s1')
    await service.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    await expect(service.start({ sessionId, provider: 'alpha', cwd: '/tmp' }))
      .rejects.toMatchObject({ code: 'DUPLICATE_SESSION' })

    await expect(service.prompt(SessionId('none'), 'hi')).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
    expect(() => { service.interrupt(SessionId('none')) }).toThrow(expect.objectContaining({ code: 'UNKNOWN_SESSION' }))
    await expect(service.compact(SessionId('none'))).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
    await expect(service.setModel(SessionId('none'), 'm')).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
    await expect(service.dispose(SessionId('none'))).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
  })

  it('rolls back the route when provider start fails', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    provider.startError = new Error('start failed')
    service.registerProvider(provider)
    const sessionId = SessionId('start-failed')

    await expect(service.start({ sessionId, provider: 'alpha', cwd: '/tmp' }))
      .rejects.toThrow('start failed')

    provider.startError = undefined
    await expect(service.start({ sessionId, provider: 'alpha', cwd: '/tmp' })).resolves.toBeUndefined()
    expect(provider.startCount).toBe(2)
  })

  it('resumes a durable provider thread without calling start', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    service.registerProvider(provider)
    const sessionId = SessionId('resume-1')

    await service.resume({ sessionId, provider: 'alpha', cwd: '/tmp' }, ExternalProviderThreadId('opaque-thread-1'))

    expect(provider.startCount).toBe(0)
    expect(provider.resumed).toEqual([{
      sessionId,
      providerThreadId: ExternalProviderThreadId('opaque-thread-1'),
    }])
  })

  it('rejects a resume without a durable provider thread id', async () => {
    const { service } = await setup()
    service.registerProvider(new StubProvider('alpha', 'Alpha'))

    await expect(service.resume({
      sessionId: SessionId('resume-missing-id'), provider: 'alpha', cwd: '/tmp',
    }, ExternalProviderThreadId(''))).rejects.toMatchObject({ code: 'INVALID_PROVIDER_THREAD_ID' })
  })

  it('shares one in-flight resume and rolls back its route after rejection', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    const gate = Promise.withResolvers<undefined>()
    provider.resumeGate = gate.promise
    service.registerProvider(provider)
    const sessionId = SessionId('resume-race')

    const first = service.resume({ sessionId, provider: 'alpha', cwd: '/tmp' }, ExternalProviderThreadId('opaque-thread-race'))
    const second = service.resume({ sessionId, provider: 'alpha', cwd: '/tmp' }, ExternalProviderThreadId('opaque-thread-race'))
    await Promise.resolve()
    expect(provider.resumed).toHaveLength(1)
    gate.reject(new Error('resume failed'))
    await expect(first).rejects.toThrow('resume failed')
    await expect(second).rejects.toThrow('resume failed')
    await expect(service.prompt(sessionId, 'after failure')).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
  })

  it('waits for late startup before provider teardown and shares concurrent disposal', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    const gate = Promise.withResolvers<undefined>()
    provider.startGate = gate.promise
    service.registerProvider(provider)
    const sessionId = SessionId('start-dispose-race')

    const start = service.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    await Promise.resolve()
    const firstDispose = service.dispose(sessionId)
    const secondDispose = service.dispose(sessionId)

    expect(provider.disposed).toEqual([])
    expect(secondDispose).toBe(firstDispose)
    gate.resolve(undefined)

    await expect(start).rejects.toMatchObject({ code: 'SESSION_DISPOSED' })
    await expect(firstDispose).resolves.toBeUndefined()
    expect(provider.disposed).toEqual([sessionId])
    await expect(service.prompt(sessionId, 'after disposal')).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
  })

  it('waits for prior provider teardown before resuming and disposes each generation once', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    const teardownGate = Promise.withResolvers<undefined>()
    provider.disposeGate = teardownGate.promise
    service.registerProvider(provider)
    const sessionId = SessionId('teardown-then-resume')
    const request = { sessionId, provider: 'alpha', cwd: '/tmp' }

    await service.start(request)
    const firstDispose = service.dispose(sessionId)
    const resume = service.resume(request, ExternalProviderThreadId('provider-thread'))
    await provider.disposeEntered.promise

    expect(provider.resumed).toEqual([])
    expect(provider.disposed).toEqual([sessionId])

    teardownGate.resolve(undefined)
    await expect(firstDispose).resolves.toBeUndefined()
    await expect(resume).resolves.toBeUndefined()
    expect(provider.resumed).toEqual([{ sessionId, providerThreadId: ExternalProviderThreadId('provider-thread') }])

    const nextTeardownGate = Promise.withResolvers<undefined>()
    provider.disposeGate = nextTeardownGate.promise
    const secondDispose = service.dispose(sessionId)
    expect(secondDispose).not.toBe(firstDispose)
    nextTeardownGate.resolve(undefined)
    await expect(secondDispose).resolves.toBeUndefined()
    expect(provider.disposed).toEqual([sessionId, sessionId])
  })

  it('disposes a scope when durable recorder seeding rejects before retention', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ExternalSessions)
    const provider = new StubProvider('alpha', 'Alpha')
    ctx.externalSessions.registerProvider(provider)
    const sessionId = SessionId('invalid-seeded-recorder')
    const invalidCall = {
      type: 'external/tool-call',
      seq: 0,
      time: 1,
      data: {
        callId: ExternalToolCallId('seed-call'),
        name: '',
        arguments: {},
      },
    } as SessionEvent<'external/tool-call'>
    ctx.sessions.create(sessionId, { seed: [invalidCall] })
    const ownerContext = (ctx.externalSessions as unknown as { readonly ctx: Context }).ctx
    const effectsBeforeAttach = ownerContext.fiber.getEffects().length

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' }))
        .rejects.toMatchObject({ code: 'INVALID_TOOL_RECORD' })
    }

    expect(ownerContext.fiber.getEffects()).toHaveLength(effectsBeforeAttach)
  })
})

describe('ExternalSessions dispatch', () => {
  it('emits streamDelta as a typed live event without appending a durable session event', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const { service } = await (async () => {
      await ctx.plugin(ExternalSessions)
      return { service: ctx.externalSessions }
    })()
    const provider = new StubProvider('alpha', 'Alpha')
    service.registerProvider(provider)
    const sessionId = SessionId('delta-session')
    const session = ctx.sessions.create(sessionId)
    const seen: unknown[] = []
    ctx.on('external/session-delta', (payload) => { seen.push(payload) })

    await service.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    provider.lastBridge!.streamDelta(sessionId, ExternalTurnId('turn-1'), 'partial')

    expect(seen).toEqual([{ sessionId, turnId: ExternalTurnId('turn-1'), delta: 'partial' }])
    expect(session.events).toEqual([])
  })

  it('drops a late streamDelta after the external session route is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ExternalSessions)
    const provider = new StubProvider('alpha', 'Alpha')
    ctx.externalSessions.registerProvider(provider)
    const sessionId = SessionId('delta-disposed-session')
    ctx.sessions.create(sessionId)
    const seen: unknown[] = []
    ctx.on('external/session-delta', (payload) => { seen.push(payload) })

    await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    const bridge = provider.lastBridge!
    bridge.streamDelta(sessionId, ExternalTurnId('turn-1'), 'before dispose')
    await ctx.externalSessions.dispose(sessionId)
    bridge.streamDelta(sessionId, ExternalTurnId('turn-1'), 'after dispose')

    expect(seen).toEqual([{ sessionId, turnId: ExternalTurnId('turn-1'), delta: 'before dispose' }])
  })

  it('hands the bridge at start and dispatches prompt/interrupt/compact/setModel/dispose to the owning provider', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    service.registerProvider(provider)
    const sessionId = SessionId('s1')
    await service.start({ sessionId, provider: 'alpha', cwd: '/tmp', model: 'm0' })

    expect(provider.startCount).toBe(1)
    expect(provider.lastStart).toMatchObject({ sessionId, provider: 'alpha', cwd: '/tmp', model: 'm0' })
    expect(provider.lastBridge).toBeDefined()

    const turn = await service.prompt(sessionId, 'hello')
    expect(turn.turnId).toBe('turn-1')
    expect(provider.prompts).toEqual(['hello'])

    service.interrupt(sessionId)
    expect(provider.interrupted).toEqual([sessionId])

    await service.compact(sessionId)
    expect(provider.compacted).toEqual([sessionId])

    await service.setModel(sessionId, 'm1')
    expect(provider.switched).toEqual([{ sessionId, model: 'm1' }])

    await service.dispose(sessionId)
    expect(provider.disposed).toEqual([sessionId])
  })

  it('fires the bridge disposal signal when the session is disposed', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    service.registerProvider(provider)
    const sessionId = SessionId('s1')
    await service.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    const bridge = provider.lastBridge!
    expect(bridge.disposal.aborted).toBe(false)
    await service.dispose(sessionId)
    expect(bridge.disposal.aborted).toBe(true)
  })

  it('fails closed on an unwired permission channel', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    service.registerProvider(provider)
    const sessionId = SessionId('s1')
    await service.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    await expect(provider.lastBridge!.requestPermission(sessionId, {
      askId: 'ask-1',
      title: 'proceed?',
      options: ['allow', 'reject'],
    })).rejects.toMatchObject({ code: 'PERMISSION_UNWIRED' })
  })
})

describe('ExternalSessions permission channel', () => {
  it('routes requestPermission through a registered answerer', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    service.registerProvider(provider)
    service.registerPermissionChannel(async (_sid, ask) =>
      ask.options[0] === 'allow' ? 'allowed' : 'rejected')
    const sessionId = SessionId('s1')
    await service.start({ sessionId, provider: 'alpha', cwd: '/tmp' })

    await expect(provider.lastBridge!.requestPermission(sessionId, {
      askId: 'ask-1',
      title: 'proceed?',
      options: ['allow', 'reject'],
    })).resolves.toBe('allowed')
  })

  it('rejects a duplicate permission channel loud', async () => {
    const { service } = await setup()
    service.registerPermissionChannel(async () => 'cancelled')
    expect(() => { service.registerPermissionChannel(async () => 'cancelled') })
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_PERMISSION_CHANNEL' }))
  })

  it('disposal of the permission channel restores the fail-closed default (HMR safety)', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    service.registerProvider(provider)
    const sessionId = SessionId('s1')
    await service.start({ sessionId, provider: 'alpha', cwd: '/tmp' })

    const dispose = service.registerPermissionChannel(async () => 'allowed')
    await expect(provider.lastBridge!.requestPermission(sessionId, {
      askId: 'ask-1',
      title: 'proceed?',
      options: ['allow', 'reject'],
    })).resolves.toBe('allowed')

    dispose()
    await expect(provider.lastBridge!.requestPermission(sessionId, {
      askId: 'ask-1',
      title: 'proceed?',
      options: ['allow', 'reject'],
    })).rejects.toMatchObject({ code: 'PERMISSION_UNWIRED' })
  })
})

describe('ExternalSessions bridge to the session log', () => {
  it('appends an accepted event fragment to a live session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ExternalSessions)
    const sessionId = SessionId('s1')
    ctx.sessions.create(sessionId)

    const provider = new StubProvider('alpha', 'Alpha')
    ctx.externalSessions.registerProvider(provider)
    await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })

    provider.lastBridge!.appendEvent(sessionId, { type: 'turn/start', data: { turn: 1 } })

    const session = ctx.sessions.get(sessionId)!
    expect(session.events.some(event => event.type === 'turn/start')).toBe(true)
  })

  it('drops append silently when no live session exists', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha')
    service.registerProvider(provider)
    const sessionId = SessionId('s1')
    await service.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    // No SessionStore is mounted, so the append targets no live session and is dropped.
    expect(() => { provider.lastBridge!.appendEvent(sessionId, { type: 'turn/start', data: { turn: 1 } }) }).not.toThrow()
  })

  it('records one bounded external tool call before its matching result', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ExternalSessions)
    const provider = new StubProvider('alpha', 'Alpha')
    ctx.externalSessions.registerProvider(provider)
    const sessionId = SessionId('tool-records')
    const session = ctx.sessions.create(sessionId)
    await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    const principal = provider.lastBridge?.principal
    if (principal === undefined) throw new Error('external bridge did not provide a principal')
    provider.lastBridge?.appendEvent(sessionId, { type: 'external/turn-started', data: { turnId: 'turn-1' } })

    await principal.recorder.recordCall?.({
      callId: ExternalToolCallId('call-1'),
      name: 'read',
      arguments: { path: 'README.md' },
    })
    await principal.recorder.recordResult?.({
      callId: ExternalToolCallId('call-1'),
      isError: false,
      result: { text: 'hello' },
    })

    expect(session.events.map(event => event.type)).toEqual([
      'external/turn-started',
      'external/tool-call',
      'external/tool-result',
    ])
    expect(session.events[1]?.data).toMatchObject({
      turnId: 'turn-1',
      callId: ExternalToolCallId('call-1'),
      name: 'read',
      arguments: { path: 'README.md' },
    })
    expect(session.events[2]?.data).toMatchObject({
      turnId: 'turn-1',
      callId: ExternalToolCallId('call-1'),
      name: 'read',
      isError: false,
      result: { text: 'hello' },
    })
  })

  it('detaches mutable call, result, and error inputs before queueing', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ExternalSessions)
    const provider = new StubProvider('alpha', 'Alpha')
    ctx.externalSessions.registerProvider(provider)
    const sessionId = SessionId('tool-record-snapshot')
    const session = ctx.sessions.create(sessionId)
    await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    const principal = provider.lastBridge?.principal
    if (principal === undefined) throw new Error('external bridge did not provide a principal')

    const callArguments = { nested: { value: 'before-call' } }
    const call = principal.recorder.recordCall?.({
      callId: ExternalToolCallId('snapshot-call'),
      name: 'read',
      arguments: callArguments,
    })
    callArguments.nested.value = 'after-call'
    await call

    const resultValue = { nested: { value: 'before-result' } }
    const result = principal.recorder.recordResult?.({
      callId: ExternalToolCallId('snapshot-call'),
      isError: false,
      result: resultValue,
    })
    resultValue.nested.value = 'after-result'
    await result

    const errorValue = { message: 'before-error', info: { code: 'E_BEFORE' } }
    const errorCall = principal.recorder.recordCall?.({
      callId: ExternalToolCallId('snapshot-error'),
      name: 'write',
      arguments: {},
    })
    await errorCall
    const errorResult = principal.recorder.recordResult?.({
      callId: ExternalToolCallId('snapshot-error'),
      isError: true,
      error: errorValue,
    })
    errorValue.message = 'after-error'
    errorValue.info.code = 'E_AFTER'
    await errorResult

    expect(session.events.at(-4)?.data).toMatchObject({
      callId: ExternalToolCallId('snapshot-call'),
      arguments: { nested: { value: 'before-call' } },
    })
    expect(session.events.at(-3)?.data).toMatchObject({
      callId: ExternalToolCallId('snapshot-call'),
      result: { nested: { value: 'before-result' } },
    })
    expect(session.events.at(-1)?.data).toMatchObject({
      callId: ExternalToolCallId('snapshot-error'),
      error: { message: 'before-error', code: 'E_BEFORE' },
    })
  })

  it('rejects non-JSON and oversized recorder payloads, and makes errors explicit', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ExternalSessions)
    const provider = new StubProvider('alpha', 'Alpha')
    ctx.externalSessions.registerProvider(provider)
    const sessionId = SessionId('tool-record-bounds')
    ctx.sessions.create(sessionId)
    await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    const principal = provider.lastBridge?.principal
    if (principal === undefined) throw new Error('external bridge did not provide a principal')

    await expect(principal.recorder.recordCall?.({
      callId: ExternalToolCallId('bad-json'),
      name: 'read',
      arguments: { value: BigInt(1) },
    })).rejects.toThrow(/JSON-serializable/)
    await expect(principal.recorder.recordCall?.({
      callId: ExternalToolCallId('too-large'),
      name: 'read',
      arguments: { value: 'x'.repeat(200_000) },
    })).rejects.toThrow(/too large/)

    await principal.recorder.recordCall?.({
      callId: ExternalToolCallId('call-error'),
      name: 'write',
      arguments: {},
    })
    await principal.recorder.recordResult?.({
      callId: ExternalToolCallId('call-error'),
      isError: true,
      error: { message: 'permission denied', code: 'EACCES' },
    })
    const event = ctx.sessions.get(sessionId)?.events.at(-1)
    expect(event?.type).toBe('external/tool-result')
    expect(event?.data).toMatchObject({
      callId: ExternalToolCallId('call-error'),
      isError: true,
      error: { message: 'permission denied', code: 'EACCES' },
    })
  })

  it('rejects an unmatched result and aborts recorder operations on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ExternalSessions)
    const provider = new StubProvider('alpha', 'Alpha')
    ctx.externalSessions.registerProvider(provider)
    const sessionId = SessionId('tool-record-dispose')
    ctx.sessions.create(sessionId)
    await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    const principal = provider.lastBridge?.principal
    if (principal === undefined) throw new Error('external bridge did not provide a principal')

    await expect(principal.recorder.recordResult?.({
      callId: ExternalToolCallId('missing'),
      isError: true,
      error: { message: 'missing call' },
    })).rejects.toThrow(/no matching external tool call/)

    await principal.recorder.recordCall?.({
      callId: ExternalToolCallId('duplicate-call'),
      name: 'read',
      arguments: {},
    })
    await expect(principal.recorder.recordCall?.({
      callId: ExternalToolCallId('duplicate-call'),
      name: 'read',
      arguments: {},
    })).rejects.toThrow(/already recorded/)
    await principal.recorder.recordResult?.({
      callId: ExternalToolCallId('duplicate-call'),
      name: 'read',
      isError: false,
      value: { ok: true },
    })
    await expect(principal.recorder.recordResult?.({
      callId: ExternalToolCallId('duplicate-call'),
      name: 'read',
      isError: false,
      value: { ok: true },
    })).rejects.toThrow(/already recorded/)

    await ctx.externalSessions.dispose(sessionId)
    await expect(principal.recorder.recordCall?.({
      callId: ExternalToolCallId('after-dispose'),
      name: 'read',
      arguments: {},
    })).rejects.toThrow(/disposed/)
  })

  it('rejects a duplicate call id after a resume attachment', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ExternalSessions)
    const provider = new StubProvider('alpha', 'Alpha')
    ctx.externalSessions.registerProvider(provider)
    const sessionId = SessionId('tool-record-resume-duplicate')
    ctx.sessions.create(sessionId)
    await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
    const firstPrincipal = provider.lastBridge?.principal
    if (firstPrincipal === undefined) throw new Error('external bridge did not provide a principal')
    await firstPrincipal.recorder.recordCall?.({
      callId: ExternalToolCallId('resume-duplicate'),
      name: 'read',
      arguments: {},
    })
    await firstPrincipal.recorder.recordResult?.({
      callId: ExternalToolCallId('resume-duplicate'),
      isError: false,
      result: { ok: true },
    })
    await ctx.externalSessions.dispose(sessionId)

    await ctx.externalSessions.resume(
      { sessionId, provider: 'alpha', cwd: '/tmp' },
      ExternalProviderThreadId('resume-thread'),
    )
    const secondPrincipal = provider.lastBridge?.principal
    if (secondPrincipal === undefined) throw new Error('resume bridge did not provide a principal')
    await expect(secondPrincipal.recorder.recordCall?.({
      callId: ExternalToolCallId('resume-duplicate'),
      name: 'read',
      arguments: {},
    })).rejects.toMatchObject({ code: 'DUPLICATE_TOOL_CALL' })
  })
})

describe('ExternalSessions model listing', () => {
  it('dispatches listModels to the native-catalog provider', async () => {
    const { service } = await setup()
    const provider = new StubProvider('alpha', 'Alpha', 'provider', [
      { id: 'm1', name: 'Model One' },
    ])
    service.registerProvider(provider)
    await expect(service.listModels('alpha')).resolves.toEqual([{ id: 'm1', name: 'Model One' }])
  })

  it('a config-directory provider answers listModels from its configured roster', async () => {
    const { service } = await setup()
    // Provider-scoped Config passthrough: the roster lives with the provider,
    // which is what `modelDirectory: 'config'` advertises.
    const roster: ExternalModelInfo[] = [{ id: 'cfg-1', name: 'Config Model One' }]
    const provider: ExternalSessionProvider = {
      provider: 'cfg',
      label: 'Config',
      modelDirectory: 'config',
      async start() {},
      async resume() {},
      async prompt() { return { turnId: ExternalTurnId('t1') } },
      interrupt() {},
      async compact() {},
      async listModels() { return roster },
      async setModel() {},
      async dispose() {},
    }
    service.registerProvider(provider)

    expect(service.listAgents()).toMatchObject([{ provider: 'cfg', modelDirectory: 'config' }])
    await expect(service.listModels('cfg')).resolves.toEqual([{ id: 'cfg-1', name: 'Config Model One' }])
  })
})
