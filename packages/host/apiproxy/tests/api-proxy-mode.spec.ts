/**
 * The mode-aware session-create arms: creating a session in an external mode
 * yields a bare host session (no native Agent) whose durable header carries the
 * mode and whose `session.list` row surfaces it, while an unknown mode fails
 * loud and the external seam is optional (absent, an external mode still
 * fails loud). The native `dsh` path is unchanged by these edits and is covered
 * by the other api-proxy create suites.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ExternalSessions, {
  ExternalTurnId,
  type ExternalBridgeContext,
  type ExternalSessionProvider,
  type ExternalSessionStart,
} from '@deepseek-ai/dsh-external-session'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`mode-${String(nextRpc++)}`), payload }
}

class StubProvider implements ExternalSessionProvider {
  readonly modelDirectory = 'config'
  constructor(
    readonly provider: string,
    readonly label: string,
  ) {}
  async start(_request: ExternalSessionStart, _bridge: ExternalBridgeContext) {}
  async prompt() { return { turnId: ExternalTurnId('t1') } }
  interrupt() {}
  async listModels() { return [] }
  async setModel() {}
  async dispose() {}
}

function harness({ external = true }: { external?: boolean } = {}): Promise<Context> {
  return (async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    if (external) {
      await ctx.plugin(ExternalSessions)
      ctx.externalSessions.registerProvider(new StubProvider('alpha', 'Alpha'))
    }
    ctx.apiProxy = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    return ctx
  })()
}

describe('session.create mode arms', () => {
  it('creates a bare external session with no native agent, surfacing mode', async () => {
    const ctx = await harness()
    const result = await ctx.apiProxy.sessions.create(request({
      sessionId: SessionId('e1'),
      cwd: '/tmp',
      mode: 'alpha',
    }))
    expect(result.result.ok).toBe(true)
    const session = ctx.sessions.get(SessionId('e1'))
    expect(session?.header.mode).toBe('alpha')
    // No native Agent was created for the external mode.
    expect(ctx.get('agents')?.get(SessionId('e1'))).toBeUndefined()
    const list = await ctx.apiProxy.sessions.list(request({}))
    expect(list.result.ok).toBe(true)
    const row = list.result.ok ? list.result.value.items.find(item => item.sessionId === SessionId('e1')) : undefined
    expect(row?.mode).toBe('alpha')
  })

  it('fails loud with unknown-mode when the provider is not registered', async () => {
    const ctx = await harness()
    const result = await ctx.apiProxy.sessions.create(request({
      sessionId: SessionId('e2'),
      cwd: '/tmp',
      mode: 'nope',
    }))
    expect(result.result.ok).toBe(false)
    expect(result.result.ok ? undefined : result.result.error?.code).toBe('unknown-mode')
    expect(ctx.sessions.get(SessionId('e2'))).toBeUndefined()
  })

  it('fails loud with unknown-mode when no external seam is composed', async () => {
    const ctx = await harness({ external: false })
    const result = await ctx.apiProxy.sessions.create(request({
      sessionId: SessionId('e3'),
      cwd: '/tmp',
      mode: 'alpha',
    }))
    expect(result.result.ok).toBe(false)
    expect(result.result.ok ? undefined : result.result.error?.code).toBe('unknown-mode')
    expect(ctx.sessions.get(SessionId('e3'))).toBeUndefined()
  })
})
