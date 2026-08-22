import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ExternalSessions, {
  type ExternalSessionProvider,
  type ExternalSessionStart,
  type ExternalBridgeContext,
  type ExternalModePreflightResult,
  type ExternalSessionPreflightRequest,
  ExternalTurnId,
} from '@deepseek-ai/dsh-external-session'

class Provider implements ExternalSessionProvider {
  readonly provider = 'codex'
  readonly label = 'Codex'
  readonly modelDirectory = 'provider' as const
  preflightResult: ExternalModePreflightResult = { ok: true }

  async preflight(_request: ExternalSessionPreflightRequest): Promise<ExternalModePreflightResult> {
    return this.preflightResult
  }

  async start(_request: ExternalSessionStart, _bridge: ExternalBridgeContext): Promise<void> {}
  async resume(_request: ExternalSessionStart, _bridge: ExternalBridgeContext, _thread: never): Promise<void> {}
  async prompt(): Promise<{ turnId: ReturnType<typeof ExternalTurnId> }> {
    return { turnId: ExternalTurnId('turn-1') }
  }
  interrupt(): void {}
  async compact(): Promise<void> {}
  async listModels(): Promise<never[]> { return [] }
  async setModel(): Promise<void> {}
  async dispose(): Promise<void> {}
}

describe('external-session preflight', () => {
  it('returns the provider decision and preserves typed availability failures', async () => {
    const ctx = new Context()
    await ctx.plugin(ExternalSessions)
    const provider = new Provider()
    provider.preflightResult = {
      ok: false,
      failure: { code: 'AUTH_UNAVAILABLE', message: 'Codex account is not authenticated.' },
    }
    ctx.externalSessions.registerProvider(provider)

    const result = await ctx.externalSessions.preflight('codex', { cwd: '/tmp', sandbox: 'read-only' })

    expect(result).toEqual({
      ok: false,
      failure: { code: 'AUTH_UNAVAILABLE', message: 'Codex account is not authenticated.' },
    })
    await ctx.fiber.dispose()
  })

  it('rejects an unknown provider before any provider operation', async () => {
    const ctx = new Context()
    await ctx.plugin(ExternalSessions)
    await expect(ctx.externalSessions.preflight('missing', { cwd: '/tmp' })).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' })
    await ctx.fiber.dispose()
  })
})
