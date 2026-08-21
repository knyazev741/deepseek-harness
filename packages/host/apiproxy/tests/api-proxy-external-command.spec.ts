/**
 * The per-session-mode command routing arms (`session.command`): an
 * external-mode session routes `/compact` to its provider's native compact
 * (recording `external/compaction-noticed`), `/model <id>` to `setModel`
 * (`external/model-switched`), and any other line — slash or plain — verbatim
 * as prompt text; a native-mode session rejects with `invalid-mode`. The
 * stub provider models the Codex provider's contract: those arms write the
 * durable events through the per-session bridge.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ExternalSessions, {
  ExternalProviderThreadId,
  ExternalTurnId,
  type ExternalBridgeContext,
  type ExternalModePreflightResult,
  type ExternalSessionProvider,
  type ExternalSessionStart,
} from '@deepseek-ai/dsh-external-session'
import * as ExternalSessionBridge from '@deepseek-ai/dsh-external-session-bridge'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`cmd-${String(nextRpc++)}`), payload }
}

/** Stub external provider recording command arms and writing durable events. */
class CommandProvider implements ExternalSessionProvider {
  readonly modelDirectory = 'config'
  lastBridge: ExternalBridgeContext | undefined
  started = 0
  readonly resumed: ExternalProviderThreadId[] = []
  readonly compacted = new Set<SessionId>()
  readonly switched: Array<{ sessionId: SessionId; model: string }> = []
  readonly prompts: string[] = []
  rejectModel = false
  rejectListModels: Error | undefined
  listModelsCalls = 0
  models: Array<{ id: string; name: string; description?: string }> = []
  preflightResult: ExternalModePreflightResult = { ok: true }

  constructor(
    readonly provider: string,
    readonly label: string,
  ) {}

  async start(_request: ExternalSessionStart, bridge: ExternalBridgeContext): Promise<void> {
    this.started += 1
    this.lastBridge = bridge
  }
  async preflight() { return this.preflightResult }
  async resume(_request: ExternalSessionStart, bridge: ExternalBridgeContext, providerThreadId: ExternalProviderThreadId): Promise<void> {
    this.resumed.push(providerThreadId)
    this.lastBridge = bridge
  }
  async prompt(sessionId: SessionId, text: string) {
    this.prompts.push(text)
    this.lastBridge!.appendEvent(sessionId, { type: 'external/message-added', data: { turnId: 't1', role: 'user', text } })
    return { turnId: ExternalTurnId('t1') }
  }
  interrupt() {}
  async compact(sessionId: SessionId) {
    this.compacted.add(sessionId)
    this.lastBridge!.appendEvent(sessionId, {
      type: 'external/compaction-noticed',
      data: { notice: 'The external agent compacted its conversation context.' },
    })
  }
  async listModels() {
    this.listModelsCalls += 1
    if (this.rejectListModels !== undefined) throw this.rejectListModels
    return this.models
  }
  async setModel(sessionId: SessionId, model: string) {
    if (this.rejectModel) {
      throw new Error('external-session-codex: the Codex app-server 0.147.0 exposes no runtime model-switch on a live thread')
    }
    this.switched.push({ sessionId, model })
    this.lastBridge!.appendEvent(sessionId, { type: 'external/model-switched', data: { model } })
  }
  async dispose() {}
}

/** Keyless harness: external-session registry + a stub provider on `alpha`. */
async function harness(): Promise<{ ctx: Context; provider: CommandProvider }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ExternalSessions)
  const provider = new CommandProvider('alpha', 'Alpha')
  ctx.externalSessions.registerProvider(provider)
  ctx.apiProxy = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { ctx, provider }
}

let context: Context | undefined
let restartRoot: string | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (restartRoot !== undefined) await rm(restartRoot, { recursive: true, force: true })
  restartRoot = undefined
})

interface RestartProviderState {
  started: number
  readonly resumed: ExternalProviderThreadId[]
  readonly resumeModels: unknown[]
  readonly prompts: string[]
  bridge: ExternalBridgeContext | undefined
}

/** Provider state used by the real Loader/persistence restart test. */
function restartProvider(state: RestartProviderState): ExternalSessionProvider {
  return {
    provider: 'alpha',
    label: 'Alpha',
    modelDirectory: 'config',
    async start(request, bridge) {
      state.started += 1
      state.bridge = bridge
      bridge.appendEvent(request.sessionId, {
        type: 'external/session-started',
        data: {
          provider: 'alpha',
          cwd: request.cwd,
          providerThreadId: ExternalProviderThreadId('jsonl-restart-thread'),
        },
      })
    },
    async resume(request, bridge, providerThreadId) {
      state.resumed.push(providerThreadId)
      state.resumeModels.push(request.model)
      state.bridge = bridge
    },
    async prompt(sessionId, text) {
      state.prompts.push(text)
      state.bridge!.appendEvent(sessionId, {
        type: 'external/message-added',
        data: { turnId: 'restart-turn', role: 'user', text },
      })
      return { turnId: ExternalTurnId('restart-turn') }
    },
    interrupt() {},
    async compact() {},
    async listModels() { return [] },
    async setModel() {},
    async dispose() {},
  }
}

/** Build one fresh host composition over the same JSONL root. */
async function loadRestartComposition(
  root: string,
  state: RestartProviderState,
): Promise<Context> {
  const configPath = join(root, `cordis-${String(state.started)}.yml`)
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${join(root, 'sessions')}`,
    '    compression: none',
    '    writeBatchMaxDelayMs: 1',
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-external-session'",
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-external-session-bridge'",
    "- name: 'stub:restart-provider'",
    '',
  ].join('\n'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-session-projection', SessionProjection],
    ['@deepseek-ai/dsh-external-session', ExternalSessions],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-external-session-bridge', ExternalSessionBridge],
    ['stub:restart-provider', {
      name: 'stub:restart-provider',
      inject: ['externalSessions'],
      apply(providerContext: Context) {
        providerContext.externalSessions.registerProvider(restartProvider(state))
      },
    }],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  ctx.apiProxy = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
  return ctx
}

/** Cross the bridge's async session-created dispatch. */
function flushRestartStart(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('session external-mode JSONL restart', () => {
  it('keeps reads process-free and resumes once on the first live operation', async () => {
    restartRoot = await mkdtemp(join(tmpdir(), 'dsh-external-jsonl-restart-'))
    const sessionId = SessionId('jsonl-restart')
    const firstState: RestartProviderState = { started: 0, resumed: [], resumeModels: [], prompts: [], bridge: undefined }
    const first = await loadRestartComposition(restartRoot, firstState)
    context = first

    const created = await first.apiProxy.sessions.create(request({
      sessionId,
      cwd: '/tmp',
      mode: 'alpha',
    }))
    expect(created.result).toMatchObject({ ok: true, value: { sessionId } })
    await flushRestartStart()
    expect(firstState.started).toBe(1)
    expect(firstState.resumed).toEqual([])
    const firstSession = first.sessions.get(sessionId)
    if (firstSession === undefined) throw new Error('first composition did not publish the session')
    await first.sessions.flush(firstSession)
    const raw = await first.sessionPersistence.readRaw(sessionId)
    expect(raw?.content).toContain('jsonl-restart-thread')

    await first.fiber.dispose()
    context = undefined

    const secondState: RestartProviderState = { started: 0, resumed: [], resumeModels: [], prompts: [], bridge: undefined }
    const second = await loadRestartComposition(restartRoot, secondState)
    context = second
    try {
      const listed = await second.apiProxy.sessions.list(request({}))
      expect(listed.result).toMatchObject({ ok: true, value: { items: [{ sessionId }] } })
      const history = await second.apiProxy.sessions.history(request({ sessionId }))
      expect(history.result).toMatchObject({ ok: true })
      expect(secondState.started).toBe(0)
      expect(secondState.resumed).toEqual([])
      expect((await second.sessionPersistence.list()).map(meta => meta.id)).toContain(sessionId)
      expect((await second.sessionPersistence.list()).find(meta => meta.id === sessionId)?.mode).toBe('alpha')
      expect(second.get('externalSessions')).toBeDefined()

      const prepare = vi.spyOn(second.sessionPersistence, 'prepare')
      const enter = vi.spyOn(second.sessions, 'enter')
      const announce = vi.spyOn(second.sessions, 'announce')
      const command = await second.apiProxy.sessions.command(request({ sessionId, line: 'resume after restart' }))

      expect(command.result).toMatchObject({ ok: true, value: { kind: 'success' } })
      expect(secondState.started).toBe(0)
      expect(secondState.resumed).toEqual([ExternalProviderThreadId('jsonl-restart-thread')])
      expect(secondState.prompts).toEqual(['resume after restart'])
      expect(prepare).toHaveBeenCalledOnce()
      expect(enter).toHaveBeenCalledOnce()
      expect(announce).toHaveBeenCalledOnce()
      const resumedSession = second.sessions.get(sessionId)
      if (resumedSession === undefined) throw new Error('resume did not publish the session')
      await second.sessions.flush(resumedSession)
      expect((await second.sessionPersistence.readRaw(sessionId))?.content)
        .toContain('resume after restart')
    } finally {
      await second.fiber.dispose()
      context = undefined
    }
  })

  it.each([
    ['mode', { mode: 42, model: 'valid-model' }],
    ['model', { mode: 'alpha', model: 42 }],
  ] as const)('does not list or resume a cold JSONL session with malformed %s metadata', async (field, metadata) => {
    restartRoot = await mkdtemp(join(tmpdir(), 'dsh-external-jsonl-invalid-'))
    const sessionId = SessionId(`jsonl-invalid-${field}`)
    const sessionDir = join(restartRoot, 'sessions', '--tmp--', sessionId)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.jsonl'), [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1,
        cwd: '/tmp',
        delegationDepth: 0,
        ...metadata,
      }),
      JSON.stringify({ type: 'session/end-seed', seq: 0, time: 1, data: {} }),
      '',
    ].join('\n'))
    const state: RestartProviderState = { started: 0, resumed: [], resumeModels: [], prompts: [], bridge: undefined }
    const ctx = await loadRestartComposition(restartRoot, state)
    context = ctx
    try {
      const listed = await ctx.apiProxy.sessions.list(request({}))
      expect(listed.result).toMatchObject({ ok: true, value: { items: [] } })
      expect(state.started).toBe(0)
      expect(state.resumed).toEqual([])

      const command = await ctx.apiProxy.sessions.command(request({
        sessionId,
        line: 'must not resume',
      }))
      expect(command.result).toMatchObject({ ok: false })
      expect(state.started).toBe(0)
      expect(state.resumed).toEqual([])
      expect(state.resumeModels).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      context = undefined
    }
  })
})

/**
 * Create an external-mode session through the gateway, then start its provider
 * the way the external-session-bridge driver does on `session/created` (that
 * driver is not composed in this unit harness), so the session is live and the
 * routing arms dispatch to it.
 */
async function bootExternal(ctx: Context, sessionId: SessionId): Promise<void> {
  await ctx.apiProxy.sessions.create(request({ sessionId, cwd: '/tmp', mode: 'alpha' }))
  await ctx.externalSessions.start({ sessionId, provider: 'alpha', cwd: '/tmp' })
}

describe('session.command external-mode routing', () => {
  it('serves session.models from the external provider catalog only', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    provider.models = [{ id: 'external-model', name: 'External Model', description: 'provider-owned' }]
    const sessionId = SessionId('cold-models')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.models(request({ sessionId }))
    expect(result.result).toEqual({
      ok: true,
      value: {
        current: { provider: 'alpha', model: '' },
        routable: true,
        groups: [{
          id: 'alpha',
          name: 'Alpha',
          models: [{ id: 'external-model', name: 'External Model', description: 'provider-owned' }],
        }],
        failures: [],
      },
    })
    expect(provider.listModelsCalls).toBe(1)
  })

  it('reports an external provider catalog failure without native rows', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    provider.rejectListModels = new Error('external catalog offline')
    const sessionId = SessionId('external-models-failure')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.models(request({ sessionId }))
    expect(result.result).toEqual({
      ok: true,
      value: {
        current: { provider: 'alpha', model: '' },
        routable: true,
        groups: [],
        failures: [{ id: 'alpha', name: 'Alpha', message: 'external catalog offline' }],
      },
    })
    expect(provider.listModelsCalls).toBe(1)
  })

  it('materializes one cold external session and resumes its durable thread on first command', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    await ctx.plugin(ExternalSessionBridge)
    const sessionId = SessionId('cold-command')
    const meta = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/tmp',
      mode: 'alpha',
    }
    const events = [{
      type: 'external/session-started' as const,
      seq: 0,
      time: 1,
      data: { provider: 'alpha', cwd: '/tmp', providerThreadId: ExternalProviderThreadId('opaque-cold-command') },
      ignorable: true as const,
    }]
    const inspect = vi.fn(async () => ({ meta, events }))
    const prepare = vi.fn(async () => SessionPreparation.create(ctx.sessions.prepare(sessionId, {
      seed: events,
      meta,
      seedSource: 'persistence',
    })))
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      inspect,
      prepare,
    } as never)

    const history = await ctx.apiProxy.sessions.history(request({ sessionId }))
    expect(history.result.ok).toBe(true)
    expect(provider.started).toBe(0)
    expect(provider.resumed).toEqual([])

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: 'resume me' }))
    expect(result.result.ok).toBe(true)
    expect(provider.started).toBe(0)
    expect(provider.resumed).toEqual(['opaque-cold-command'])
    expect(prepare).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalled()
    expect(ctx.sessions.get(sessionId)?.header.id).toBe(sessionId)
  })

  it('routes /compact to the provider native compact and records the notice', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    const sessionId = SessionId('e1')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/compact' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toMatchObject({ kind: 'success' })
    expect(provider.compacted.has(sessionId)).toBe(true)
    const session = ctx.sessions.get(sessionId)!
    expect(session.events.map(event => event.type)).toContain('external/compaction-noticed')
  })

  it('routes /model <id> to setModel and records the switch event', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    const sessionId = SessionId('e2')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/model gpt-5' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toMatchObject({ kind: 'success' })
    expect(provider.switched).toEqual([{ sessionId, model: 'gpt-5' }])
    const session = ctx.sessions.get(sessionId)!
    expect(session.events.map(event => event.type)).toContain('external/model-switched')
  })

  it('rejects /model without an argument as an error outcome', async () => {
    const { ctx } = await harness()
    context = ctx
    const sessionId = SessionId('e3')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/model' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toEqual({ kind: 'error', text: 'Usage: /model <model-id>' })
  })

  it('surfaces a setModel rejection as an error outcome', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    provider.rejectModel = true
    const sessionId = SessionId('e4')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/model gpt-5' }))
    expect(result.result.ok).toBe(true)
    const value = result.result.ok ? result.result.value : undefined
    expect(value).toMatchObject({ kind: 'error' })
    if (value?.kind === 'error') expect(value.text).toContain('no runtime model-switch')
  })

  it('passes an unknown slash command through as prompt text', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    const sessionId = SessionId('e5')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/not-a-command arg' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toMatchObject({ kind: 'success' })
    expect(provider.prompts).toEqual(['/not-a-command arg'])
  })

  it('passes a plain non-slash line through as prompt text', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    const sessionId = SessionId('e6')
    await bootExternal(ctx, sessionId)

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: 'hello there' }))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toMatchObject({
      kind: 'success',
      externalTurnId: 't1',
    })
    expect(provider.prompts).toEqual(['hello there'])
  })

  it('rejects a native-mode session with invalid-mode', async () => {
    const { ctx } = await harness()
    context = ctx
    const sessionId = SessionId('n1')
    // A native (no mode) session created directly; its lines route through the
    // agent-loop command registry, not the external per-mode boundary.
    ctx.sessions.create(sessionId, { meta: { cwd: '/tmp' } })

    const result = await ctx.apiProxy.sessions.command(request({ sessionId, line: '/compact' }))
    expect(result.result.ok).toBe(false)
    expect(result.result.ok ? undefined : result.result.error?.code).toBe('invalid-mode')
  })

  it('rejects an unknown session with session-not-found', async () => {
    const { ctx } = await harness()
    context = ctx
    const result = await ctx.apiProxy.sessions.command(request({ sessionId: SessionId('missing'), line: '/compact' }))
    expect(result.result.ok).toBe(false)
    expect(result.result.ok ? undefined : result.result.error?.code).toBe('session-not-found')
  })
})

describe('session.externalModes new-session mode catalog', () => {
  it('lists registered external modes with their model catalogs', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    provider.models = [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', description: 'smaller' },
    ]

    const result = await ctx.apiProxy.sessions.externalModes(request({}))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toEqual({
      groups: [{
        provider: 'alpha',
        label: 'Alpha',
        modelDirectory: 'config',
        models: [
          { id: 'gpt-5', name: 'GPT-5' },
          { id: 'gpt-5-mini', name: 'GPT-5 Mini', description: 'smaller' },
        ],
      }],
      failures: [],
    })
  })

  it('keeps a mode selectable in failures when its catalog lookup rejects', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    // Force listModels to reject by replacing it.
    const original = provider.listModels.bind(provider)
    provider.listModels = async () => { throw new Error('catalog down') }

    const result = await ctx.apiProxy.sessions.externalModes(request({}))
    expect(result.result.ok).toBe(true)
    const value = result.result.ok ? result.result.value : undefined
    expect(value).toEqual({
      groups: [],
      failures: [{
        provider: 'alpha',
        label: 'Alpha',
        message: 'catalog down',
      }],
    })
    provider.listModels = original
  })

  it('exposes typed provider preflight failures without a model group', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    provider.preflightResult = {
      ok: false,
      failure: { code: 'AUTH_UNAVAILABLE', message: 'Codex account is not authenticated.' },
    }
    const result = await ctx.apiProxy.sessions.externalModes(request({}))
    expect(result.result).toMatchObject({
      ok: true,
      value: {
        groups: [],
        failures: [{ provider: 'alpha', label: 'Alpha', code: 'AUTH_UNAVAILABLE' }],
      },
    })
  })

  it('projects a timed-out preflight as a bounded failure without probing models', async () => {
    const { ctx, provider } = await harness()
    context = ctx
    provider.preflightResult = {
      ok: false,
      failure: { code: 'PREFLIGHT_FAILED', message: 'Codex preflight timed out before the app-server became ready.' },
    }
    const result = await ctx.apiProxy.sessions.externalModes(request({}))
    expect(result.result).toMatchObject({
      ok: true,
      value: {
        groups: [],
        failures: [{ provider: 'alpha', label: 'Alpha', code: 'PREFLIGHT_FAILED' }],
      },
    })
    expect(provider.listModelsCalls).toBe(0)
  })

  it('returns empty when no external-session registry is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    context = ctx
    ctx.apiProxy = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const result = await ctx.apiProxy.sessions.externalModes(request({}))
    expect(result.result.ok).toBe(true)
    expect(result.result.ok ? result.result.value : undefined).toEqual({ groups: [], failures: [] })
  })
})
