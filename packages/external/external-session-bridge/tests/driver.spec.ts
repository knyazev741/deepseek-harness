/**
 * Unit tests for the external-session bridge driver arms that the REAL
 * composition test does not reach: the fail-loud path when a session is created
 * in a mode with no registered provider, and the register-then-start reaction.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import ExternalSessions, {
  ExternalTurnId,
  type ExternalBridgeContext,
  type ExternalSessionProvider,
  type ExternalSessionStart,
} from '@deepseek-ai/dsh-external-session'
import * as bridge from '@deepseek-ai/dsh-external-session-bridge'

class StubProvider implements ExternalSessionProvider {
  readonly modelDirectory = 'config'
  started: boolean | undefined

  constructor(
    readonly provider: string,
    readonly label: string,
  ) {}

  async start(request: ExternalSessionStart, bridgeCtx: ExternalBridgeContext): Promise<void> {
    this.started = true
    bridgeCtx.appendEvent(request.sessionId, {
      type: 'external/session-started',
      data: { provider: this.provider, cwd: request.cwd },
    })
  }
  async prompt() { return { turnId: ExternalTurnId('t1') } }
  interrupt() {}
  async compact() {}
  async listModels() { return [] }
  async setModel() {}
  async dispose() {}
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function setup(): Promise<{ ctx: Context; provider: StubProvider }> {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(ExternalSessions)
  await ctx.plugin(bridge)
  const provider = new StubProvider('alpha', 'Alpha')
  ctx.externalSessions.registerProvider(provider)
  return { ctx, provider }
}

describe('external-session-bridge driver', () => {
  it('starts the registered provider for an external-mode session', async () => {
    const { ctx: loaded, provider } = await setup()
    const session = loaded.sessions.create(SessionId('a1'), { meta: { cwd: '/tmp', mode: 'alpha' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(provider.started).toBe(true)
    expect(session.events.map(event => event.type)).toContain('external/session-started')
  })

  it('fails loud when a session is created in an unknown mode', async () => {
    const { ctx: loaded } = await setup()
    expect(() => loaded.sessions.create(SessionId('z1'), { meta: { cwd: '/tmp', mode: 'missing' } }))
      .toThrow(/was created in mode "missing".*no such external provider is registered/)
  })
})
