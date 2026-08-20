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
import { ExternalProviderThreadId, ExternalToolCallId } from '@deepseek-ai/dsh-external-session'
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
  session.append('external/session-started', {
    provider: 'codex',
    cwd: '/work',
    model: 'gpt-5',
    providerThreadId: ExternalProviderThreadId('opaque-thread-1'),
  })
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
      {
        provider: 'codex',
        cwd: '/work',
        model: 'gpt-5',
        providerThreadId: ExternalProviderThreadId('opaque-thread-1'),
      },
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
      {
        type: 'external/session-started',
        seq: 0,
        time: 1,
        data: {
          provider: 'codex',
          cwd: '/work',
          providerThreadId: ExternalProviderThreadId('opaque-thread-unknown'),
        },
      },
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
      providerThreadId: ExternalProviderThreadId('opaque-thread-unknown'),
      turns: [
        {
          turnId: 't1',
          messages: [],
          toolActivities: [],
          toolCalls: [],
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
      providerThreadId: ExternalProviderThreadId('opaque-thread-1'),
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
          toolCalls: [],
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

  it('preserves the opaque provider thread id for attachment without rendering it as transcript content', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    session.append('external/session-started', {
      provider: 'codex',
      cwd: '/work',
      providerThreadId: ExternalProviderThreadId('opaque-thread-for-resume'),
    })

    const projection = ctx.sessionProjections.snapshot(session).values['external/transcript']
    expect(projection).toMatchObject({
      providerThreadId: ExternalProviderThreadId('opaque-thread-for-resume'),
    })
    expect(projection).not.toHaveProperty('turns.0.providerThreadId')
  })

  it('leaves unrelated (non-external) events out of the fold and shows an open turn', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    session.append('external/session-started', {
      provider: 'codex',
      cwd: '/work',
      providerThreadId: ExternalProviderThreadId('opaque-thread-unrelated'),
    })
    session.append('external/turn-started', { turnId: 't1' })
    session.append('external/message-added', { turnId: 't1', role: 'agent', text: 'before unrelated' })
    session.append('turn/start', { turn: 1 })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } })
    const snapshot = ctx.sessionProjections.snapshot(session)
    // The open turn is served until it is ended; the core events contribute nothing.
    expect(snapshot.values['external/transcript']).toEqual({
      provider: 'codex',
      cwd: '/work',
      providerThreadId: ExternalProviderThreadId('opaque-thread-unrelated'),
      turns: [
        {
          turnId: 't1',
          messages: [{ role: 'agent', text: 'before unrelated' }],
          toolActivities: [],
          toolCalls: [],
          permissions: [],
          compactionNotices: [],
          modelSwitches: [],
        },
      ],
    })
  })

  it('pairs durable external tool call/result events into replayable tool nodes', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    session.append('external/session-started', {
      provider: 'codex',
      cwd: '/work',
      providerThreadId: ExternalProviderThreadId('opaque-tools'),
    })
    session.append('external/turn-started', { turnId: 'turn-tools' })
    session.append('external/tool-call', {
      turnId: 'turn-tools',
      callId: ExternalToolCallId('call-tools'),
      name: 'read',
      arguments: { path: 'README.md' },
    })
    session.append('external/tool-result', {
      turnId: 'turn-tools',
      callId: ExternalToolCallId('call-tools'),
      name: 'read',
      isError: false,
      result: { text: 'hello' },
    })

    expect(ctx.sessionProjections.snapshot(session).values['external/transcript']).toMatchObject({
      turns: [{
        turnId: 'turn-tools',
        toolCalls: [{
          callId: ExternalToolCallId('call-tools'),
          name: 'read',
          arguments: { path: 'README.md' },
          result: { text: 'hello' },
        }],
      }],
    })
  })

  it('replays an explicit external tool error on the paired node', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    session.append('external/session-started', {
      provider: 'codex',
      cwd: '/work',
      providerThreadId: ExternalProviderThreadId('opaque-tool-error'),
    })
    session.append('external/turn-started', { turnId: 'turn-error' })
    session.append('external/tool-call', {
      turnId: 'turn-error',
      callId: ExternalToolCallId('call-error-node'),
      name: 'write',
      arguments: { path: 'README.md', text: 'nope' },
    })
    session.append('external/tool-result', {
      turnId: 'turn-error',
      callId: ExternalToolCallId('call-error-node'),
      name: 'write',
      isError: true,
      error: { message: 'permission denied', code: 'EACCES' },
    })

    expect(ctx.sessionProjections.snapshot(session).values['external/transcript']).toMatchObject({
      turns: [{
        toolCalls: [{
          callId: ExternalToolCallId('call-error-node'),
          name: 'write',
          arguments: { path: 'README.md', text: 'nope' },
          error: { message: 'permission denied', code: 'EACCES' },
        }],
      }],
    })
  })

  it('ignores malformed external turns and tool calls without breaking snapshots', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    session.append('external/session-started', {
      provider: 'codex',
      cwd: '/work',
      providerThreadId: ExternalProviderThreadId('opaque-malformed-turn'),
    })
    session.append('external/turn-started', { turnId: '' })
    session.append('external/tool-call', {
      callId: ExternalToolCallId(''),
      name: 'read',
      arguments: {},
    })
    session.append('external/tool-call', {
      callId: ExternalToolCallId('malformed-name'),
      name: '',
      arguments: {},
    })

    expect(() => ctx.sessionProjections.snapshot(session)).not.toThrow()
    expect(ctx.sessionProjections.snapshot(session).values['external/transcript']).toMatchObject({ turns: [] })
  })

  it('ignores a result with the wrong tool name', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    session.append('external/session-started', {
      provider: 'codex',
      cwd: '/work',
      providerThreadId: ExternalProviderThreadId('opaque-wrong-name'),
    })
    session.append('external/turn-started', { turnId: 'turn-wrong-name' })
    session.append('external/tool-call', {
      turnId: 'turn-wrong-name',
      callId: ExternalToolCallId('wrong-name-call'),
      name: 'read',
      arguments: {},
    })
    session.append('external/tool-result', {
      turnId: 'turn-wrong-name',
      callId: ExternalToolCallId('wrong-name-call'),
      name: 'write',
      isError: false,
      result: { ignored: true },
    })

    const projection = ctx.sessionProjections.snapshot(session).values['external/transcript']
    expect(projection).toMatchObject({ turns: [{ toolCalls: [{ name: 'read', arguments: {} }] }] })
    expect(projection).not.toHaveProperty('turns.0.toolCalls.0.result')
  })

  it('keeps one durable call node and its first result when duplicates appear', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    session.append('external/session-started', {
      provider: 'codex',
      cwd: '/work',
      providerThreadId: ExternalProviderThreadId('opaque-duplicate-records'),
    })
    session.append('external/turn-started', { turnId: 'turn-duplicate-records' })
    const call = {
      turnId: 'turn-duplicate-records',
      callId: ExternalToolCallId('duplicate-call'),
      name: 'read',
      arguments: {},
    }
    session.append('external/tool-call', call)
    session.append('external/tool-call', call)
    session.append('external/tool-result', {
      turnId: 'turn-duplicate-records',
      callId: ExternalToolCallId('duplicate-call'),
      name: 'read',
      isError: false,
      result: { first: true },
    })
    session.append('external/tool-result', {
      turnId: 'turn-duplicate-records',
      callId: ExternalToolCallId('duplicate-call'),
      name: 'read',
      isError: false,
      result: { second: true },
    })

    const projection = ctx.sessionProjections.snapshot(session).values['external/transcript']
    expect(projection).toMatchObject({
      turns: [{ toolCalls: [{ callId: ExternalToolCallId('duplicate-call'), result: { first: true } }] }],
    })
    expect(projection?.turns[0]?.toolCalls).toHaveLength(1)
  })

  it('ignores a conflicting result that carries both success and error fields', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
    session.append('external/session-started', {
      provider: 'codex',
      cwd: '/work',
      providerThreadId: ExternalProviderThreadId('opaque-conflicting-result'),
    })
    session.append('external/turn-started', { turnId: 'turn-conflicting-result' })
    session.append('external/tool-call', {
      turnId: 'turn-conflicting-result',
      callId: ExternalToolCallId('conflicting-result'),
      name: 'write',
      arguments: {},
    })
    session.append('external/tool-result', {
      turnId: 'turn-conflicting-result',
      callId: ExternalToolCallId('conflicting-result'),
      name: 'write',
      isError: false,
      result: { ok: true },
      error: { message: 'also failed' },
    } as never)

    const projection = ctx.sessionProjections.snapshot(session).values['external/transcript']
    expect(projection).toMatchObject({
      turns: [{ toolCalls: [{ callId: ExternalToolCallId('conflicting-result'), name: 'write', arguments: {} }] }],
    })
    expect(projection).not.toHaveProperty('turns.0.toolCalls.0.result')
    expect(projection).not.toHaveProperty('turns.0.toolCalls.0.error')
  })
})
