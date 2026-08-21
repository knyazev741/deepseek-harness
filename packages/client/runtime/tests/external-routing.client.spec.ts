import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { HostFrame, RpcRequest, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import { Session } from '../src/client/sessions/session.ts'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, deferred, ok, fakeRemote } from './fake-api.client.ts'

const SID = 'external-client-session' as SessionId

function externalSession(api = new FakeApiClient()): { api: FakeApiClient; session: Session } {
  return {
    api,
    session: new Session(SID, api, fakeRemote(), { mode: 'codex' }),
  }
}

function endExternalTurn(session: Session, seq: number, turnId: string): void {
  session.handleMuxEnvelope(`external-end-${seq}` as never, {
    type: 'session/event',
    sessionId: SID,
    event: {
      type: 'external/turn-ended',
      seq,
      time: seq,
      data: { turnId, stopReason: 'completed' },
    } as SessionEvent,
  })
}

describe('external client routing', () => {
  it('retains the durable mode in list rows and resident sessions across reconnect pulls', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [{
      sessionId: SID,
      updatedAt: 1,
      running: false,
      blank: false,
      mode: 'codex',
    }] as never[] }))
    const manager = new SessionManager(api, fakeRemote())
    await manager.refreshList()
    expect(manager.getListSnapshot().items[0]?.mode).toBe('codex')
    expect(manager.get(SID).mode).toBe('codex')

    manager.handleDisconnected()
    manager.handleConnected()
    await manager.refreshList()
    expect(manager.getListSnapshot().items[0]?.mode).toBe('codex')
    expect(manager.get(SID).mode).toBe('codex')
  })

  it('configures a resident session from a creation frame before external input can route', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api, fakeRemote())
    const session = manager.get(SID)
    const frame: HostFrame = { type: 'host/session-added', sessionId: SID, blank: true, mode: 'codex' }

    manager.handleHostEnvelope({ rpcId: RpcId('host-add'), payload: frame } satisfies RpcRequest<HostFrame>)

    const image = await session.prompt([{ type: 'image', mediaType: 'image/png', data: 'AA==' }], 'queue')
    const queue = await session.updateQueue('queued-item' as never, { kind: 'remove' })
    const steer = await session.prompt([{ type: 'text', text: 'steer' }], 'steer')

    expect(session.mode).toBe('codex')
    expect(image).toMatchObject({ ok: false, error: { code: 'external-images-unsupported' } })
    expect(queue).toMatchObject({ ok: false, error: { code: 'external-queue-unsupported' } })
    expect(steer).toMatchObject({ ok: false, error: { code: 'external-steer-unsupported' } })
    expect(api.callsOf('session.prompt')).toEqual([])
    expect(api.callsOf('session.command')).toEqual([])
  })

  it('configures a resident session from a create mutation before external input can route', async () => {
    const api = new FakeApiClient()
    api.onCreate = () => Promise.resolve(ok({ sessionId: SID }))
    const manager = new SessionManager(api, fakeRemote())
    const session = manager.get(SID)

    await expect(manager.create({ sessionId: SID, mode: 'codex' })).resolves.toMatchObject({ ok: true })
    const image = await session.prompt([{ type: 'image', mediaType: 'image/png', data: 'AA==' }], 'queue')

    expect(session.mode).toBe('codex')
    expect(image).toMatchObject({ ok: false, error: { code: 'external-images-unsupported' } })
    expect(api.callsOf('session.prompt')).toEqual([])
  })

  it('routes plain and pass-through slash commands through api.sessions.command', async () => {
    const { api, session } = externalSession()
    let seq = 0
    api.onCommand = () => {
      queueMicrotask(() => { endExternalTurn(session, ++seq, `turn-${seq}`) })
      return Promise.resolve(ok({ kind: 'success' as const }))
    }

    await expect(session.command('plain prompt')).resolves.toMatchObject({ ok: true })
    await expect(session.command('/provider-specific value')).resolves.toMatchObject({ ok: true })
    expect(api.callsOf('session.command')).toEqual([
      { sessionId: SID, line: 'plain prompt' },
      { sessionId: SID, line: '/provider-specific value' },
    ])
  })

  it('routes a plain queue prompt through command while rejecting images, queue edits, and steer', async () => {
    const { api, session } = externalSession()
    api.onCommand = () => {
      queueMicrotask(() => { endExternalTurn(session, 1, 'turn-1') })
      return Promise.resolve(ok({ kind: 'success' as const }))
    }
    const image = await session.prompt([{ type: 'image', mediaType: 'image/png', data: 'AA==' }], 'queue')
    const prompt = await session.prompt([{ type: 'text', text: 'plain prompt' }], 'queue')
    const queue = await session.updateQueue('queued-item' as never, { kind: 'remove' })
    const steer = await session.prompt([{ type: 'text', text: 'steer' }], 'steer')

    expect(image).toMatchObject({ ok: false, error: { code: 'external-images-unsupported' } })
    expect(prompt).toMatchObject({ ok: true, value: { accepted: true } })
    expect(queue).toMatchObject({ ok: false, error: { code: 'external-queue-unsupported' } })
    expect(steer).toMatchObject({ ok: false, error: { code: 'external-steer-unsupported' } })
    expect(api.callsOf('session.prompt')).toEqual([])
    expect(api.callsOf('session.command')).toEqual([{ sessionId: SID, line: 'plain prompt' }])
  })

  it('rejects native goal commands locally without touching remotes', async () => {
    const { api, session } = externalSession()
    await expect(session.command('/goal')).resolves.toMatchObject({
      ok: false,
      error: { code: 'external-goals-unsupported' },
    })
    await expect(session.command('/goals')).resolves.toMatchObject({
      ok: false,
      error: { code: 'external-goals-unsupported' },
    })
    await expect(session.command('/plan')).resolves.toMatchObject({
      ok: false,
      error: { code: 'external-goals-unsupported' },
    })
    expect(api.callsOf('session.command')).toEqual([])
  })

  it('keeps command completion pending until external/turn-ended arrives', async () => {
    const { api, session } = externalSession()
    api.onCommand = () => Promise.resolve(ok({ kind: 'success' as const }))
    await session.open()

    let settled = false
    const command = session.command('wait for completion').then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    session.handleMuxEnvelope('external-end' as never, {
      type: 'session/event',
      sessionId: SID,
      event: {
        type: 'external/turn-ended',
        seq: 1,
        time: 1,
        data: { turnId: 'turn-1', stopReason: 'completed' },
      } as SessionEvent,
    })
    await command
    expect(settled).toBe(true)
  })

  it('keeps a cold external command pending until external/turn-ended arrives', async () => {
    const { api, session } = externalSession()
    api.onCommand = () => Promise.resolve(ok({ kind: 'success' as const }))

    let settled = false
    const command = session.command('cold prompt').then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    session.handleMuxEnvelope('cold-end' as never, {
      type: 'session/event',
      sessionId: SID,
      event: {
        type: 'external/turn-ended',
        seq: 1,
        time: 1,
        data: { turnId: 'cold-turn', stopReason: 'completed' },
      } as SessionEvent,
    })
    await command
    expect(settled).toBe(true)
  })

  it('keeps a loading external command pending across the history race', async () => {
    const { api, session } = externalSession()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    api.onCommand = () => Promise.resolve(ok({ kind: 'success' as const }))
    const opening = session.open()

    let settled = false
    const command = session.command('loading prompt').then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    session.handleMuxEnvelope('loading-end' as never, {
      type: 'session/event',
      sessionId: SID,
      event: {
        type: 'external/turn-ended',
        seq: 1,
        time: 1,
        data: { turnId: 'loading-turn', stopReason: 'completed' },
      } as SessionEvent,
    })
    await command
    expect(settled).toBe(true)
    history.resolve(ok({ events: [], hasMore: false }))
    await opening
  })

  it('does not wait for non-turn external commands', async () => {
    const { api, session } = externalSession()
    api.onCommand = () => Promise.resolve(ok({ kind: 'success' as const }))

    await expect(session.command('/compact')).resolves.toMatchObject({ ok: true })
    await expect(session.command('/model gpt-5')).resolves.toMatchObject({ ok: true })
    expect(api.callsOf('session.command')).toEqual([
      { sessionId: SID, line: '/compact' },
      { sessionId: SID, line: '/model gpt-5' },
    ])
  })

  it('releases a pending external command when the session is removed', async () => {
    const { api, session } = externalSession()
    api.onCommand = () => Promise.resolve(ok({ kind: 'success' as const }))

    const command = session.command('removed prompt')
    await Promise.resolve()
    session.handleRemoved()

    await expect(command).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('releases a pending external command when its resident scope is disposed', async () => {
    const { api, session } = externalSession()
    api.onCommand = () => Promise.resolve(ok({ kind: 'success' as const }))

    const command = session.command('disposed prompt')
    await Promise.resolve()
    session.dispose()

    await expect(command).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
  })
})
