/**
 * Tests for the external-permission bridge: an external session's permission
 * ask routed to the human through the user-questions channel, mapping the
 * first two ask options to allowed/rejected and dismissal/timeout/no-selection
 * to cancelled. Also covers the external-session fail-closed default when no
 * channel is wired and when its fibre disposes (HMR safety).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ExternalSessions, {
  ExternalTurnId,
  type ExternalBridgeContext,
  type ExternalSessionProvider,
  type ExternalSessionStart,
} from '@deepseek-ai/dsh-external-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService, {
  type AskUserQuestionRequest,
  type UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import * as externalPermission from '@deepseek-ai/dsh-external-permission'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

class StubProvider implements ExternalSessionProvider {
  readonly modelDirectory = 'provider'
  lastBridge: ExternalBridgeContext | undefined

  constructor(
    readonly provider: string,
    readonly label: string,
  ) {}

  async start(_request: ExternalSessionStart, bridge: ExternalBridgeContext): Promise<void> {
    this.lastBridge = bridge
  }

  async prompt() { return { turnId: ExternalTurnId('t1') } }
  interrupt() {}
  async compact() {}
  async listModels() { return [] }
  async setModel() {}
  async dispose() {}
}

/** A scripted user-questions provider answering with a fixed selection. */
function questionProvider(selected: string[]): UserQuestionProvider & { seen: AskUserQuestionRequest[] } {
  const seen: AskUserQuestionRequest[] = []
  return {
    seen,
    async ask(request) {
      seen.push(request)
      return { answers: [{ id: request.questions[0]?.id ?? 'missing', selected }] }
    },
  }
}

const ASK = { askId: 'ask-1', title: 'proceed?', options: ['allow', 'reject'] } as const

async function setup(timeoutMs?: number): Promise<{
  ctx: Context
  provider: StubProvider
  sessionId: SessionId
  fiber: { dispose(): Promise<void> }
}> {
  const ctx = new Context()
  await ctx.plugin(ExternalSessions)
  await ctx.plugin(UserQuestionService)
  const fiber = await ctx.plugin(externalPermission, timeoutMs === undefined ? {} : { timeoutMs })
  const provider = new StubProvider('alpha', 'Alpha')
  ctx.externalSessions.registerProvider(provider)
  const sessionId = SessionId('s1')
  await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
  return { ctx, provider, sessionId, fiber }
}

describe('external-permission decision mapping', () => {
  it('resolves the first ask option to allowed through the real service registration', async () => {
    const { ctx, provider, sessionId } = await setup()
    ctx.userQuestions.registerProvider(questionProvider(['allow']))

    await expect(provider.lastBridge!.requestPermission(sessionId, { ...ASK }))
      .resolves.toBe('allowed')
  })

  it('resolves the second ask option to rejected', async () => {
    const { ctx, provider, sessionId } = await setup()
    ctx.userQuestions.registerProvider(questionProvider(['reject']))

    await expect(provider.lastBridge!.requestPermission(sessionId, { ...ASK }))
      .resolves.toBe('rejected')
  })

  it('resolves an empty selection (dismissal) to cancelled', async () => {
    const { ctx, provider, sessionId } = await setup()
    ctx.userQuestions.registerProvider(questionProvider([]))

    await expect(provider.lastBridge!.requestPermission(sessionId, { ...ASK }))
      .resolves.toBe('cancelled')
  })

  it('maps the human question onto the ask with an explicit option per offered choice', async () => {
    const { ctx, provider, sessionId } = await setup()
    const qp = questionProvider(['allow'])
    ctx.userQuestions.registerProvider(qp)

    await provider.lastBridge!.requestPermission(sessionId, { ...ASK })
    expect(qp.seen[0]?.questions).toEqual([
      { id: 'ask-1', question: 'proceed?', options: [{ label: 'allow' }, { label: 'reject' }] },
    ])
  })
})

describe('external-permission bounded timeout', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('resolves cancelled when the human never answers within timeoutMs', async () => {
    const { ctx, provider, sessionId } = await setup(1000)
    const never = { ask: () => new Promise<never>(() => {}) } satisfies UserQuestionProvider
    ctx.userQuestions.registerProvider(never)

    const pending = provider.lastBridge!.requestPermission(sessionId, { ...ASK })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe('cancelled')
  })
})

describe('external-permission fail-closed arms', () => {
  it('rejects loud with PERMISSION_UNANSWERED when no user-questions provider is registered', async () => {
    const { provider, sessionId } = await setup()
    await expect(provider.lastBridge!.requestPermission(sessionId, { ...ASK }))
      .rejects.toMatchObject({ code: 'PERMISSION_UNANSWERED' })
  })

  it('no permission channel registered = the external-session fail-closed throw', async () => {
    const ctx = new Context()
    await ctx.plugin(ExternalSessions)
    const provider = new StubProvider('alpha', 'Alpha')
    ctx.externalSessions.registerProvider(provider)
    const sessionId = SessionId('s1')
    await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })

    await expect(provider.lastBridge!.requestPermission(sessionId, { ...ASK }))
      .rejects.toMatchObject({ code: 'PERMISSION_UNWIRED' })
  })

  it('disposing the plugin fibre restores the fail-closed default (HMR safety)', async () => {
    const { ctx, provider, sessionId, fiber } = await setup()
    ctx.userQuestions.registerProvider(questionProvider(['allow']))

    await expect(provider.lastBridge!.requestPermission(sessionId, { ...ASK }))
      .resolves.toBe('allowed')

    await fiber.dispose()
    await expect(provider.lastBridge!.requestPermission(sessionId, { ...ASK }))
      .rejects.toMatchObject({ code: 'PERMISSION_UNWIRED' })
  })

  it('rejects a config timeoutMs above MAX_TIMER_DELAY_MS loud at load', async () => {
    const ctx = new Context()
    await ctx.plugin(ExternalSessions)
    await ctx.plugin(UserQuestionService)
    await expect(ctx.plugin(externalPermission, { timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(/timeoutMs/)
  })
})
