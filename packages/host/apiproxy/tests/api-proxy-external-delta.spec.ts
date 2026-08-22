/**
 * The host projects the external-session live event into a transient mux
 * frame. The frame is delivered to an open mux consumer and never enters the
 * durable session event stream.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ExternalSessions, { ExternalTurnId } from '@deepseek-ai/dsh-external-session'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

async function harness(): Promise<{ ctx: Context; sessionId: SessionId }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ExternalSessions)
  const sessionId = SessionId('external-delta-session')
  ctx.sessions.create(sessionId)
  return { ctx, sessionId }
}

describe('external delta mux projection', () => {
  it('broadcasts only while a mux subscription is open and does not append a session event', async () => {
    const { ctx, sessionId } = await harness()
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    })
    const abort = new AbortController()
    const stream = api.events.mux({ rpcId: RpcId('external-delta-mux'), payload: {} }, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    ctx.emit('external/session-delta', { sessionId, turnId: ExternalTurnId('turn-1'), delta: 'partial' })
    const next = await iterator.next()
    if (next.done) throw new Error('mux stream closed before the external delta')
    const frame = next.value.payload
    expect(frame).toEqual({ type: 'external/delta', sessionId, turnId: 'turn-1', delta: 'partial' })
    abort.abort()
    if (iterator.return !== undefined) await iterator.return()

    expect(ctx.sessions.get(sessionId)?.events).toEqual([])
    // A later delta has no queue to receive it once the subscription closes.
    expect(() => {
      ctx.emit('external/session-delta', { sessionId, turnId: ExternalTurnId('turn-1'), delta: 'late' })
    }).not.toThrow()
  })

  it('keeps the frame branch narrow at the TypeScript boundary', () => {
    const frame: MuxFrame = {
      type: 'external/delta', sessionId: SessionId('s'), turnId: ExternalTurnId('turn'), delta: 'x',
    }
    expect(frame.type).toBe('external/delta')
  })
})
