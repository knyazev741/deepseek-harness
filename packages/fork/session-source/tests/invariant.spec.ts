import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@knyazevai/dsh-invariants'
import SessionStore, { SessionId } from '@knyazevai/dsh-session'
import * as ForkSessionSourceInvariant from '../src/invariant.ts'

const activeContexts: Context[] = []

afterEach(async () => {
  await Promise.all(activeContexts.splice(0).map(context => context.fiber.dispose()))
})

async function setup(): Promise<Context> {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ForkSessionSourceInvariant)
  return ctx
}

describe('fork session source invariant', () => {
  it('validates existing markers and ignores unrelated events', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('preexisting-valid'), {
      seed: [
        {
          type: 'session/title',
          seq: 0,
          time: Date.now(),
          data: { title: 'preexisting' },
        },
        {
          type: 'fork/session-source',
          seq: 1,
          time: Date.now(),
          data: { source: 'github-actions' },
          ignorable: true,
        },
      ] as never,
    })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ForkSessionSourceInvariant)

    const session = ctx.sessions.create(SessionId('unrelated-dispatch'))
    const unrelatedCandidate = {
      type: 'session/title',
      seq: 0,
      time: Date.now(),
      data: { title: 'unrelated' },
    } as never
    expect(() => { ctx.events.emit('internal/dispatch', 'emit', 'session/event', [session, unrelatedCandidate]) })
      .not.toThrow()
    expect(() => { ctx.events.emit('internal/dispatch', 'emit', 'other/event', []) }).not.toThrow()
  })

  it('rejects duplicate, malformed, non-literal, and non-ignorable markers', async () => {
    const ctx = await setup()
    const duplicate = ctx.sessions.create(SessionId('invalid-duplicate'))

    duplicate.append('fork/session-source', { source: 'github-actions' }, { ignorable: true })
    expect(() => duplicate.append('fork/session-source', { source: 'github-actions' }, { ignorable: true })).toThrow()

    const payload = ctx.sessions.create(SessionId('invalid-payload'))
    expect(() => payload.append('fork/session-source', { source: 'not-github-actions' } as never, { ignorable: true }))
      .toThrow(/non-literal/)

    const nullPayload = ctx.sessions.create(SessionId('invalid-null-payload'))
    expect(() => nullPayload.append('fork/session-source', null as never, { ignorable: true })).toThrow(/non-literal/)

    const arrayPayload = ctx.sessions.create(SessionId('invalid-array-payload'))
    expect(() => arrayPayload.append('fork/session-source', [] as never, { ignorable: true })).toThrow(/non-literal/)

    const marker = ctx.sessions.create(SessionId('invalid-ignorable'))
    expect(() => marker.append('fork/session-source', { source: 'github-actions' })).toThrow()

    const dispatchSession = ctx.sessions.create(SessionId('invalid-dispatch'))
    const surfaceCandidate = {
      type: 'fork/session-source',
      seq: 0,
      time: Date.now(),
      data: { source: 'github-actions' },
      ignorable: true,
      surfaceOp: 'append',
    } as never
    expect(() => { ctx.events.emit('internal/dispatch', 'emit', 'session/event', [dispatchSession, surfaceCandidate]) })
      .toThrow(/surface metadata/)
  })

  it('rejects an invalid marker already present in a replayed session', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('invalid-replay'), {
      seed: [{
        type: 'fork/session-source',
        seq: 0,
        time: Date.now(),
        data: { source: 'not-github-actions' },
        ignorable: true,
      } as never],
    })
    await ctx.plugin(InvariantRegistry)

    await expect(ctx.plugin(ForkSessionSourceInvariant).then(() => undefined)).rejects.toMatchObject({
      code: 'INVARIANT',
      packageName: '@knyazevai/dsh-fork-session-source',
    })
  })

  it('rejects duplicate markers already present in a replayed session', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('duplicate-replay'), {
      seed: [
        {
          type: 'fork/session-source',
          seq: 0,
          time: Date.now(),
          data: { source: 'github-actions' },
          ignorable: true,
        },
        {
          type: 'fork/session-source',
          seq: 1,
          time: Date.now(),
          data: { source: 'github-actions' },
          ignorable: true,
        },
      ] as never,
    })
    await ctx.plugin(InvariantRegistry)

    await expect(ctx.plugin(ForkSessionSourceInvariant).then(() => undefined)).rejects.toMatchObject({
      code: 'INVARIANT',
      packageName: '@knyazevai/dsh-fork-session-source',
    })
  })
})
