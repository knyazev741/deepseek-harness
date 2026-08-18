/**
 * The `external/*` session event vocabulary and its transcript projection:
 * every event round-trips through a real Session and replays, an unknown
 * `external/*`-prefixed type carrying the envelope's `ignorable` marker reads
 * back without corrupting the fold, and the projection unit folds a scripted
 * turn sequence into transcript-shaped state.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry, {
  externalTranscriptProjectionDefinition,
} from '@deepseek-ai/dsh-session-projection'

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, session: ctx.sessions.create() }
}

/** Append one committed external transcript, exercising every event type. */
function appendFullExternalRun(session: Session): void {
  session.append('external/session-started', { provider: 'codex', cwd: '/work', model: 'gpt-5' })
  session.append('external/turn-started', { turnId: 't1' })
  session.append('external/message-added', { turnId: 't1', role: 'user', text: 'add a test' })
  session.append('external/message-added', { turnId: 't1', role: 'agent', text: 'on it' })
  session.append('external/tool-activity', { turnId: 't1', kind: 'call', title: 'grep' })
  session.append('external/tool-activity', { turnId: 't1', kind: 'result', title: 'grep', detail: '1 match' })
  session.append('external/permission-asked', { askId: 'p1', title: 'Allow run?', options: ['allow', 'deny'] })
  session.append('external/permission-decided', { askId: 'p1', outcome: 'allowed' })
  session.append('external/compaction-noticed', { notice: 'compacted 3 turns' })
  session.append('external/model-switched', { model: 'gpt-5.1' })
  session.append('external/turn-ended', { turnId: 't1', stopReason: 'completed' })
  session.append('external/session-ended', { stopReason: 'completed' })
}

/** Data of the log's `external/*` events (replay replays include the auto-`session/end-seed` marker). */
function externalData(events: readonly SessionEvent[]): unknown[] {
  return events.filter(event => (event.type as string).startsWith('external/')).map(event => event.data)
}

describe('external/* event vocabulary', () => {
  it('round-trips every event through a real Session and replays them', () => {
    const original = Session.create(SessionId('orig'))
    appendFullExternalRun(original)
    expect(original.seq).toBe(12)

    const expectedData = [
      { provider: 'codex', cwd: '/work', model: 'gpt-5' },
      { turnId: 't1' },
      { turnId: 't1', role: 'user', text: 'add a test' },
      { turnId: 't1', role: 'agent', text: 'on it' },
      { turnId: 't1', kind: 'call', title: 'grep' },
      { turnId: 't1', kind: 'result', title: 'grep', detail: '1 match' },
      { askId: 'p1', title: 'Allow run?', options: ['allow', 'deny'] },
      { askId: 'p1', outcome: 'allowed' },
      { notice: 'compacted 3 turns' },
      { model: 'gpt-5.1' },
      { turnId: 't1', stopReason: 'completed' },
      { stopReason: 'completed' },
    ]
    expect(externalData(original.events)).toEqual(expectedData)

    // Replay: seeding a fresh Session with the read-back log reproduces it.
    const replayed = Session.create(SessionId('replay'), [...original.events])
    expect(externalData(replayed.events)).toEqual(expectedData)
    expect(externalData(replayed.events).length).toBe(12)
  })

  it('reads back an unknown external/* type marked ignorable without corrupting replay or the fold', async () => {
    const unknown: SessionEvent = {
      type: 'external/unknown-future',
      seq: 1,
      time: 2,
      data: { payload: true },
      ignorable: true,
    } as unknown as SessionEvent
    // The unknown event survives a Session seeded with it (the read path skips
    // an ignorable type it does not know instead of refusing the log). Seeding
    // replays the constructor's auto-`session/end-seed`, hence length 4.
    const seeded = Session.create(SessionId('unknown-seed'), [
      { type: 'external/session-started', seq: 0, time: 1, data: { provider: 'codex', cwd: '/work' } },
      unknown,
      { type: 'external/turn-started', seq: 2, time: 3, data: { turnId: 't1' } },
    ])
    expect(seeded.events).toHaveLength(4)
    expect(seeded.events[1]?.type).toBe('external/unknown-future')
    expect(seeded.events[1]?.ignorable).toBe(true)

    // Re-replay of the read-back log keeps the unknown marker.
    const replayed = Session.create(SessionId('unknown-replay'), [...seeded.events])
    expect(replayed.events[1]?.ignorable).toBe(true)

    // The fold ignores the unknown event and still reproduces the transcript.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('unknown-live'), { seed: [...seeded.events] })
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['external/transcript']).toEqual({
      provider: 'codex',
      cwd: '/work',
      turns: [
        {
          turnId: 't1',
          messages: [],
          toolActivities: [],
          permissions: [],
          compactionNotices: [],
          modelSwitches: [],
        },
      ],
    })
  })

  it('folds a scripted external turn sequence into transcript-shaped state', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    appendFullExternalRun(session)
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['external/transcript']).toEqual({
      provider: 'codex',
      cwd: '/work',
      sessionModel: 'gpt-5.1',
      turns: [
        {
          turnId: 't1',
          messages: [
            { role: 'user', text: 'add a test' },
            { role: 'agent', text: 'on it' },
          ],
          toolActivities: [
            { kind: 'call', title: 'grep' },
            { kind: 'result', title: 'grep', detail: '1 match' },
          ],
          permissions: [
            { askId: 'p1', title: 'Allow run?', options: ['allow', 'deny'], outcome: 'allowed' },
          ],
          compactionNotices: ['compacted 3 turns'],
          modelSwitches: ['gpt-5.1'],
          stopReason: 'completed',
        },
      ],
      stopReason: 'completed',
    })
  })

  it('leaves unrelated (non-external) events out of the fold and shows an open turn', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    session.append('external/session-started', { provider: 'codex', cwd: '/work' })
    session.append('external/turn-started', { turnId: 't1' })
    session.append('external/message-added', { turnId: 't1', role: 'agent', text: 'before unrelated' })
    session.append('turn/start', { turn: 1 })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text', text: 'x' } })
    const snapshot = ctx.sessionProjections.snapshot(session)
    // The open turn is served until it is ended; the core events contribute nothing.
    expect(snapshot.values['external/transcript']).toEqual({
      provider: 'codex',
      cwd: '/work',
      turns: [
        {
          turnId: 't1',
          messages: [{ role: 'agent', text: 'before unrelated' }],
          toolActivities: [],
          permissions: [],
          compactionNotices: [],
          modelSwitches: [],
        },
      ],
    })
  })
})
