import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@knyazevai/dsh-session'
import { SettingsProvider } from '@knyazevai/dsh-settings'
import { remoteMethods } from '@knyazevai/dsh-typert-protocol'
import ForkWorkspaceSessionState from '../src/index.ts'
import type {
  ForkWorkspaceSessionStateSetResult,
  ForkWorkspaceSessionStateView,
} from '../src/types.ts'

const NAMESPACE = 'fork-workspace-session-state'

interface WorkspaceRecord {
  readonly sessionIds: readonly SessionId[]
}

interface DeferredSignal {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

function deferredSignal(): DeferredSignal {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown>
  readonly writes: Array<{ ns: string; section: Record<string, unknown> }> = []
  readonly failure: Error | undefined

  constructor(ctx: Context, config?: { doc?: Record<string, unknown>; failure?: Error }) {
    super(ctx)
    this.doc = structuredClone(config?.doc ?? {})
    this.failure = config?.failure
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: string, section: Record<string, unknown>): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    this.writes.push({ ns, section: structuredClone(section) })
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

class DelayedSettings extends SettingsProvider {
  readonly persistStarted = deferredSignal()
  readonly releasePersist = deferredSignal()

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected async persist(): Promise<void> {
    this.persistStarted.resolve()
    await this.releasePersist.promise
  }
}

const activeContexts: Context[] = []

afterEach(async () => {
  await Promise.all(activeContexts.splice(0).map(context => context.fiber.dispose()))
})

async function setup(options: {
  readonly sessionIds?: readonly string[]
  readonly doc?: Record<string, unknown>
  readonly failure?: Error
} = {}): Promise<{
  readonly ctx: Context
  readonly service: ForkWorkspaceSessionState
  readonly settings: MemorySettings
  readonly settingsFiber: Awaited<ReturnType<Context['plugin']>>
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  activeContexts.push(ctx)
  const settingsConfig = {
    ...(options.doc === undefined ? {} : { doc: options.doc }),
    ...(options.failure === undefined ? {} : { failure: options.failure }),
  }
  const settingsFiber = ctx.plugin(MemorySettings, settingsConfig)
  await settingsFiber
  const settings = ctx.settings as MemorySettings
  const workspaces: WorkspaceRecord[] = [{
    sessionIds: (options.sessionIds ?? ['s1', 's2', 's3']).map(SessionId),
  }]
  ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
  const fiber = ctx.plugin(ForkWorkspaceSessionState)
  await fiber
  return { ctx, service: ctx.forkWorkspaceSessionState, settings, settingsFiber, fiber }
}

function expectSuccess(result: ForkWorkspaceSessionStateSetResult): ForkWorkspaceSessionStateView {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected a successful pin mutation')
  return result.value
}

describe('fork workspace session state', () => {
  it('starts empty at the Settings descriptor revision and exposes exactly two Remote methods', async () => {
    const { ctx, service } = await setup()

    await expect(service.list()).resolves.toEqual({ revision: 0, pinnedSessionIds: [] })
    expect(remoteMethods(service).map(marker => marker.exportName ?? marker.method)).toEqual(['list', 'setPinned'])
    expect(ctx.settings.describe().find(descriptor => descriptor.ns === NAMESPACE)?.value)
      .toEqual({ pins: { sessionIds: [] } })
  })

  it('appends pins, preserves remaining order on unpin, and makes duplicate requests no-ops', async () => {
    const { service, settings } = await setup()

    const first = expectSuccess(await service.setPinned({ sessionId: SessionId('s2'), pinned: true, expectedRevision: 0 }))
    expect(first).toEqual({ revision: 1, pinnedSessionIds: [SessionId('s2')] })
    const second = expectSuccess(await service.setPinned({ sessionId: SessionId('s1'), pinned: true, expectedRevision: 1 }))
    expect(second).toEqual({ revision: 2, pinnedSessionIds: [SessionId('s2'), SessionId('s1')] })
    const duplicate = expectSuccess(await service.setPinned({ sessionId: SessionId('s2'), pinned: true, expectedRevision: 2 }))
    expect(duplicate).toEqual(second)
    const unpinned = expectSuccess(await service.setPinned({ sessionId: SessionId('s2'), pinned: false, expectedRevision: 2 }))
    expect(unpinned).toEqual({ revision: 3, pinnedSessionIds: [SessionId('s1')] })
    expect(settings.writes).toHaveLength(3)
    expect(settings.writes.map(write => write.section)).toEqual([
      { pins: { sessionIds: ['s2'] } },
      { pins: { sessionIds: ['s2', 's1'] } },
      { pins: { sessionIds: ['s1'] } },
    ])
  })

  it('returns a typed conflict with the authoritative view for a stale revision', async () => {
    const { service } = await setup()

    const committed = expectSuccess(await service.setPinned({ sessionId: SessionId('s1'), pinned: true, expectedRevision: 0 }))
    const result = await service.setPinned({ sessionId: SessionId('s1'), pinned: true, expectedRevision: 0 })

    expect(result).toEqual({ ok: false, error: { code: 'revision-conflict', current: committed } })
  })

  it('rejects an unknown session without writing Settings', async () => {
    const { service, settings } = await setup({ sessionIds: ['s1'] })

    const result = await service.setPinned({ sessionId: SessionId('missing'), pinned: true, expectedRevision: 0 })

    expect(result).toEqual({ ok: false, error: { code: 'session-not-in-workspace', sessionId: SessionId('missing') } })
    expect(settings.writes).toEqual([])
  })

  it('removes a persisted pin after the session leaves every workspace', async () => {
    const { service, settings } = await setup({
      sessionIds: ['s1'],
      doc: { [NAMESPACE]: { pins: { sessionIds: ['detached'] } } },
    })

    const result = expectSuccess(await service.setPinned({
      sessionId: SessionId('detached'),
      pinned: false,
      expectedRevision: 0,
    }))

    expect(result).toEqual({ revision: 1, pinnedSessionIds: [] })
    expect(settings.writes).toEqual([{ ns: NAMESPACE, section: { pins: { sessionIds: [] } } }])
  })

  it('keeps the persisted pin list across service and provider remounts', async () => {
    const first = await setup()
    expectSuccess(await first.service.setPinned({ sessionId: SessionId('s3'), pinned: true, expectedRevision: 0 }))
    const persisted = structuredClone(first.settings.doc)

    await first.fiber.dispose()
    await first.settingsFiber.dispose()
    const settingsFiber = first.ctx.plugin(MemorySettings, { doc: persisted })
    await settingsFiber
    const serviceFiber = first.ctx.plugin(ForkWorkspaceSessionState)
    await serviceFiber

    await expect(first.ctx.forkWorkspaceSessionState.list()).resolves.toEqual({
      revision: 0,
      pinnedSessionIds: [SessionId('s3')],
    })
  })

  it('maps a competing Settings write at the CAS boundary to a typed conflict', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber
    let externalWrite: Promise<void> | undefined
    let raced = false
    ctx.provide('workspaceRegistry', {
      list: () => {
        if (!raced) {
          raced = true
          externalWrite = ctx.settings.update(NAMESPACE, { pins: { sessionIds: ['s3'] } })
        }
        return [{ sessionIds: [SessionId('s1'), SessionId('s3')] }]
      },
    } as never)
    const serviceFiber = ctx.plugin(ForkWorkspaceSessionState)
    await serviceFiber

    const result = await ctx.forkWorkspaceSessionState.setPinned({
      sessionId: SessionId('s1'),
      pinned: true,
      expectedRevision: 0,
    })
    await externalWrite

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'revision-conflict',
        current: { revision: 1, pinnedSessionIds: [SessionId('s3')] },
      },
    })
  })

  it('serializes simultaneous mutations with one success and one typed conflict', async () => {
    const { service, settings } = await setup()
    const first = service.setPinned({ sessionId: SessionId('s1'), pinned: true, expectedRevision: 0 })
    const second = service.setPinned({ sessionId: SessionId('s2'), pinned: true, expectedRevision: 0 })

    await expect(first).resolves.toEqual({
      ok: true,
      value: { revision: 1, pinnedSessionIds: [SessionId('s1')] },
    })
    await expect(second).resolves.toEqual({
      ok: false,
      error: {
        code: 'revision-conflict',
        current: { revision: 1, pinnedSessionIds: [SessionId('s1')] },
      },
    })
    expect(settings.writes).toEqual([{ ns: NAMESPACE, section: { pins: { sessionIds: ['s1'] } } }])
    await expect(service.list()).resolves.toEqual({ revision: 1, pinnedSessionIds: [SessionId('s1')] })
  })

  it('drains an in-flight Settings persist before withdrawing its namespace', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    const settingsFiber = ctx.plugin(DelayedSettings)
    await settingsFiber
    ctx.provide('workspaceRegistry', {
      list: () => [{ sessionIds: [SessionId('s1')] }],
    } as never)
    const fiber = ctx.plugin(ForkWorkspaceSessionState)
    await fiber
    const service = ctx.forkWorkspaceSessionState
    const mutation = service.setPinned({ sessionId: SessionId('s1'), pinned: true, expectedRevision: 0 })

    const settings = ctx.settings as DelayedSettings
    await settings.persistStarted.promise
    const disposal = fiber.dispose()
    await Promise.resolve()

    try {
      expect(ctx.settings.get(NAMESPACE)).toEqual({ pins: { sessionIds: [] } })
    } finally {
      settings.releasePersist.resolve()
    }
    await expect(mutation).resolves.toEqual({
      ok: true,
      value: { revision: 1, pinnedSessionIds: [SessionId('s1')] },
    })
    await disposal
    expect(ctx.settings.get(NAMESPACE)).toBeUndefined()
  })

  it('rejects malformed persisted pins at Settings registration', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    const settingsFiber = ctx.plugin(MemorySettings, {
      doc: { [NAMESPACE]: { pins: { sessionIds: 'not-an-array' } } },
    })
    await settingsFiber
    ctx.provide('workspaceRegistry', { list: () => [] } as never)

    await expect(ctx.plugin(ForkWorkspaceSessionState)).rejects.toThrow()
  })

  it('rejects duplicate persisted pins at Settings validation', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    const settingsFiber = ctx.plugin(MemorySettings, {
      doc: { [NAMESPACE]: { pins: { sessionIds: ['s1', 's1'] } } },
    })
    await settingsFiber
    ctx.provide('workspaceRegistry', { list: () => [] } as never)

    await expect(ctx.plugin(ForkWorkspaceSessionState)).rejects.toThrow(/must not contain duplicates/u)
  })

  it('propagates unrelated Settings failures instead of mapping them to conflicts', async () => {
    const failure = new Error('provider failure')
    const { service } = await setup({ failure })

    await expect(service.setPinned({
      sessionId: SessionId('s1'),
      pinned: true,
      expectedRevision: 0,
    })).rejects.toBe(failure)
  })

  it('recovers the serialized queue after a read failure and rejects calls after disposal', async () => {
    const { ctx, service, fiber, settings } = await setup()
    const describe = settings.describe.bind(settings)
    settings.describe = () => []

    await expect(service.list()).rejects.toThrow(/not registered/u)
    settings.describe = describe
    await expect(service.list()).resolves.toEqual({ revision: 0, pinnedSessionIds: [] })

    await fiber.dispose()
    await expect(service.list()).rejects.toThrow(/disposed/u)
    expect(ctx.get('forkWorkspaceSessionState')).toBeUndefined()
  })

  it('withdraws the Host service with its owning fiber', async () => {
    const { ctx, fiber } = await setup()

    await fiber.dispose()

    expect(ctx.get('forkWorkspaceSessionState')).toBeUndefined()
  })
})
