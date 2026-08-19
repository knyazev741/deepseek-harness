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
import ExternalSessions, {
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
  lastStart: ExternalSessionStart | undefined
  lastBridge: ExternalBridgeContext | undefined
  readonly prompts: string[] = []
  readonly interrupted: SessionId[] = []
  readonly compacted: SessionId[] = []
  readonly switched: { sessionId: SessionId; model: string }[] = []
  readonly disposed: SessionId[] = []

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
    this.lastStart = request
    this.lastBridge = bridge
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
  }
}

async function setup(): Promise<{ ctx: Context; service: ExternalSessions }> {
  const ctx = new Context()
  await ctx.plugin(ExternalSessions)
  return { ctx, service: ctx.externalSessions }
}

describe('ExternalSessions registry', () => {
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
})

describe('ExternalSessions dispatch', () => {
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
