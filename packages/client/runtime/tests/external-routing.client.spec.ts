import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { Session } from '../src/client/sessions/session.ts'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, ok, fakeRemote } from './fake-api.client.ts'

const SID = 'external-client-session' as SessionId

function externalSession(api = new FakeApiClient()): { api: FakeApiClient; session: Session } {
  return {
    api,
    session: new Session(SID, api, fakeRemote(), { mode: 'codex' }),
  }
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

  it('routes plain and pass-through slash commands through api.sessions.command', async () => {
    const { api, session } = externalSession()
    api.onCommand = () => Promise.resolve(ok({ kind: 'success' as const }))

    await expect(session.command('plain prompt')).resolves.toMatchObject({ ok: true })
    await expect(session.command('/provider-specific value')).resolves.toMatchObject({ ok: true })
    expect(api.callsOf('session.command')).toEqual([
      { sessionId: SID, line: 'plain prompt' },
      { sessionId: SID, line: '/provider-specific value' },
    ])
  })

  it('routes a plain queue prompt through command while rejecting images, queue edits, and steer', async () => {
    const { api, session } = externalSession()
    api.onCommand = () => Promise.resolve(ok({ kind: 'success' as const }))
    const image = await session.prompt([{ type: 'image', attachmentId: 'image-1' as never }], 'queue')
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
})
