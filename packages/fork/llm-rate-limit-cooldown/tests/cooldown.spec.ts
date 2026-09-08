import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Events, Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
} from '@knyazevai/dsh-llm'
import type {
  GenerateOptions,
  NormalRetryPolicyConfig,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
} from '@knyazevai/dsh-llm'
import SessionStore, { SessionId } from '@knyazevai/dsh-session'
import type { Agent, RequestErrorAction } from '@knyazevai/dsh-agent'
import SystemPrompt from '@knyazevai/dsh-system-prompt'
import ToolRuntime from '@knyazevai/dsh-tools'
import AgentRegistry from '@knyazevai/dsh-agent'
import AgentLoop from '@knyazevai/dsh-agent-loop'
import type { SessionEvent } from '@knyazevai/dsh-session'
import * as retry from '@knyazevai/dsh-llm-retry'
import * as cooldown from '../src/index.ts'
import { cancellableDelay, createEscalator, priorRetries } from '../src/escalator.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('cooldown test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configureRetryPolicies(
    policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
  ): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined
        ? undefined
        : resolveRetryPolicy(policy, `cooldown test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function rateLimited(): Error {
  return new LlmError('rate limited', 'RATE_LIMIT', { status: 429 })
}

function serverDown(): Error {
  return new LlmError('upstream provider error', 'SERVER', { status: 503 })
}

function quotaExceeded(): Error {
  return new LlmError('quota exceeded', 'QUOTA', { status: 429 })
}

function piAiCatchAll(): Error {
  return new LlmError('upstream stream failed.', 'PI_AI_ERROR', {})
}

function nonTriggerCode(): Error {
  return new LlmError('bad payload', 'INVALID_REQUEST', { status: 400 })
}

interface HarnessOptions {
  /** Mount the downstream dsh-llm-retry policy executor before this plugin. */
  includeRetry?: boolean
  /** Bound fast retry budget for the mock provider. */
  retryPolicy?: RetryPolicyConfig
  /** Cooldown installed on this plugin (omitted exercises the default). */
  cooldownMs?: number
  /** Codes escalation responds to (omitted exercises the default). */
  retryableCodes?: string[]
}

async function harness(
  adapter: ScriptedAdapter,
  options: HarnessOptions = {},
): Promise<{ ctx: Context; fiber: Fiber; disposeAdapter: () => void }> {
  const ctx = new Context()
  const pluginConfig = {
    ...(options.cooldownMs !== undefined ? { cooldownMs: options.cooldownMs } : {}),
    ...(options.retryableCodes !== undefined ? { retryableCodes: options.retryableCodes } : {}),
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (options.includeRetry) {
    await ctx.plugin(Object.assign((inner: Context) => { retry.apply(inner, {}, { random: () => 0.5 }) }, { inject: retry.inject }))
  }
  const fiber = await ctx.plugin(Object.assign((inner: Context) => { cooldown.apply(inner, pluginConfig) }, { inject: cooldown.inject }))
  adapter.configureRetryPolicies({ mock: options.retryPolicy })
  await ctx.plugin(AgentLoop, { agents: [] })
  const disposeAdapter = ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, fiber, disposeAdapter }
}

function normalConfig(
  overrides: Partial<Omit<NormalRetryPolicyConfig, 'mode'>> = {},
): NormalRetryPolicyConfig {
  const { backoff, ...policy } = overrides
  return {
    mode: 'normal',
    maxRetries: 2,
    ...policy,
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      ...backoff,
    },
  }
}

let context: Context | undefined
let disposed: (() => void) | undefined

afterEach(async () => {
  disposed?.()
  disposed = undefined
  await context?.fiber.dispose()
  context = undefined
})

/** Wait until the adapter has served `count` requests, polling real microtasks. */
async function waitForRequests(adapter: ScriptedAdapter, count: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (adapter.requests.length < count && Date.now() < deadline) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5)
      timer.unref?.()
    })
  }
  if (adapter.requests.length < count) throw new Error(`waited for ${count} requests but got ${adapter.requests.length}`)
}

/** Assert the turn closed terminally with the given failure code. */
function expectTerminal(agent: Agent, code: string): void {
  const last = agent.session.events.at(-1)
  expect(last?.type).toBe('turn/end')
  if (last?.type !== 'turn/end') return
  const reason = last.data.reason
  expect(reason.kind).toBe('error')
  if (reason.kind !== 'error') return
  expect(reason.error).toMatchObject({ code })
}

/** Minimal request-error payload with a controllable signal and budget. */
function makePayload(overrides: Record<string, unknown> = {}): Parameters<Events['agent/request-error']>[0] {
  return {
    agent: { session: { events: [] } },
    turn: 1,
    step: 1,
    provider: 'mock',
    failure: { code: 'RATE_LIMIT' },
    retryPolicy: { mode: 'normal', maxRetries: 0 } as unknown as ResolvedRetryPolicy,
    signal: new AbortController().signal,
    ...overrides,
  } as unknown as Parameters<Events['agent/request-error']>[0]
}

describe('fork-llm-rate-limit-cooldown', () => {
  it('escalates a rate-limited request whose bounded retry budget is exhausted, waits, then retries to success', async () => {
    const adapter = new ScriptedAdapter([
      rateLimited(),
      rateLimited(),
      rateLimited(),
      textResponse('done'),
    ])
    const { ctx, disposeAdapter } = await harness(adapter, {
      includeRetry: true,
      cooldownMs: 20,
      retryPolicy: normalConfig({
        retryableCodes: ['RATE_LIMIT'],
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      }),
    })
    disposed = disposeAdapter
    context = ctx
    const agent = ctx.agentLoop.create(SessionId('cooldown-success'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // Two fast llm-retry backoffs plus one cooldown retry precede the success.
    expect(adapter.requests).toHaveLength(4)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    })
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(2)
  })

  it('escalates QUOTA via the default code set', async () => {
    const adapter = new ScriptedAdapter([
      quotaExceeded(),
      quotaExceeded(),
      quotaExceeded(),
      textResponse('done'),
    ])
    const { ctx, disposeAdapter } = await harness(adapter, {
      includeRetry: true,
      cooldownMs: 20,
      retryPolicy: normalConfig({
        retryableCodes: ['RATE_LIMIT', 'SERVER', 'QUOTA', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR'],
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      }),
    })
    disposed = disposeAdapter
    context = ctx
    const agent = ctx.agentLoop.create(SessionId('cooldown-quota'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(4)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    })
  })

  it('escalates the pi-ai catch-all PI_AI_ERROR via the default code set', async () => {
    const adapter = new ScriptedAdapter([
      piAiCatchAll(),
      piAiCatchAll(),
      piAiCatchAll(),
      textResponse('done'),
    ])
    const { ctx, disposeAdapter } = await harness(adapter, {
      includeRetry: true,
      cooldownMs: 20,
      retryPolicy: normalConfig({
        retryableCodes: ['RATE_LIMIT', 'SERVER', 'QUOTA', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR'],
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      }),
    })
    disposed = disposeAdapter
    context = ctx
    const agent = ctx.agentLoop.create(SessionId('cooldown-piai'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(4)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    })
  })

  it('delegates a failure with a non-trigger code to a terminal outcome', async () => {
    const adapter = new ScriptedAdapter([nonTriggerCode()])
    const { ctx, disposeAdapter } = await harness(adapter, {
      includeRetry: false,
      retryableCodes: ['RATE_LIMIT', 'SERVER'],
      retryPolicy: normalConfig({ retryableCodes: ['RATE_LIMIT', 'SERVER'] }),
    })
    disposed = disposeAdapter
    context = ctx
    const agent = ctx.agentLoop.create(SessionId('cooldown-delegate-code'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expectTerminal(agent, 'INVALID_REQUEST')
    expect(adapter.requests).toHaveLength(1)
  })

  it('escalates an upstream 5xx (SERVER) whose bounded budget is exhausted, waits, then retries to success', async () => {
    const adapter = new ScriptedAdapter([
      serverDown(),
      serverDown(),
      serverDown(),
      textResponse('done'),
    ])
    const { ctx, disposeAdapter } = await harness(adapter, {
      includeRetry: true,
      cooldownMs: 20,
      retryPolicy: normalConfig({
        retryableCodes: ['RATE_LIMIT', 'SERVER'],
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      }),
    })
    disposed = disposeAdapter
    context = ctx
    const agent = ctx.agentLoop.create(SessionId('cooldown-server-success'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(4)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    })
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(2)
  })

  it('delegates while the bounded retry budget is not yet exhausted', async () => {
    const adapter = new ScriptedAdapter([rateLimited()])
    const { ctx, disposeAdapter } = await harness(adapter, {
      includeRetry: false,
      retryPolicy: normalConfig({ retryableCodes: ['RATE_LIMIT'] }),
    })
    disposed = disposeAdapter
    context = ctx
    const agent = ctx.agentLoop.create(SessionId('cooldown-delegate-budget'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expectTerminal(agent, 'RATE_LIMIT')
    expect(adapter.requests).toHaveLength(1)
  })

  it('delegates when the provider carries no bounded retry policy', async () => {
    const adapter = new ScriptedAdapter([rateLimited()])
    const { ctx, disposeAdapter } = await harness(adapter, {})
    disposed = disposeAdapter
    context = ctx
    const agent = ctx.agentLoop.create(SessionId('cooldown-delegate-nopolicy'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expectTerminal(agent, 'RATE_LIMIT')
    expect(adapter.requests).toHaveLength(1)
  })

  it('aborts the cooldown wait and settles terminally when the turn is cancelled', async () => {
    const adapter = new ScriptedAdapter([
      rateLimited(),
      rateLimited(),
      rateLimited(),
      textResponse('done'),
    ])
    const { ctx, disposeAdapter } = await harness(adapter, {
      includeRetry: true,
      // A long cooldown gives a wide real-time window to cancel while pending.
      cooldownMs: 60_000,
      retryPolicy: normalConfig({
        retryableCodes: ['RATE_LIMIT'],
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      }),
    })
    disposed = disposeAdapter
    context = ctx
    const agent = ctx.agentLoop.create(SessionId('cooldown-cancel'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    // The two fast retries exhaust the budget and land the third attempt in the cooldown wait.
    await waitForRequests(adapter, 3)
    expect(adapter.requests).toHaveLength(3)

    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('aborts and drains an active cooldown when the plugin is disposed', async () => {
    const adapter = new ScriptedAdapter([
      rateLimited(),
      rateLimited(),
      rateLimited(),
    ])
    const { ctx, fiber, disposeAdapter } = await harness(adapter, {
      includeRetry: true,
      cooldownMs: 60_000,
      retryPolicy: normalConfig({
        retryableCodes: ['RATE_LIMIT'],
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      }),
    })
    const agent = ctx.agentLoop.create(SessionId('cooldown-dispose'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForRequests(adapter, 3)
    expect(adapter.requests).toHaveLength(3)

    await fiber.dispose()
    disposeAdapter()
    expect(adapter.requests).toHaveLength(3)
  })
})

describe('fork-llm-rate-limit-cooldown internals', () => {
  it('resolves false when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(cancellableDelay(1_000, controller.signal)).resolves.toBe(false)
  })

  it('resolves true when the delay elapses and false when it aborts mid-wait', async () => {
    await expect(cancellableDelay(1, new AbortController().signal)).resolves.toBe(true)

    const controller = new AbortController()
    const pending = cancellableDelay(50, controller.signal)
    controller.abort()
    await expect(pending).resolves.toBe(false)
  })

  it('counts only llm/retry records scoped to the same turn, step, and provider', () => {
    const events = [
      { type: 'llm/retry', data: { turn: 1, step: 1, provider: 'mock', retry: 1 } },
      { type: 'llm/retry', data: { turn: 1, step: 1, provider: 'mock', retry: 2 } },
      { type: 'llm/retry', data: { turn: 1, step: 2, provider: 'mock', retry: 1 } },
      { type: 'turn/start', data: {} },
    ] as unknown as SessionEvent[]
    expect(priorRetries(events, 1, 1, 'mock')).toBe(2)
  })

  it('delegates an unclaimed failure through the continuation', async () => {
    const escalator = createEscalator(new Context(), 100, ['RATE_LIMIT', 'SERVER'])
    const next = vi.fn(async (): Promise<RequestErrorAction> => undefined)
    await escalator.listener(makePayload({ failure: { code: 'INVALID_REQUEST' } }), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('delegates when the provider exposes no bounded retry policy', async () => {
    const escalator = createEscalator(new Context(), 100, ['RATE_LIMIT', 'SERVER'])
    const next = vi.fn(async (): Promise<RequestErrorAction> => undefined)
    await escalator.listener(makePayload({ retryPolicy: undefined }), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('delegates an unbounded always policy owned by dsh-llm-retry', async () => {
    const escalator = createEscalator(new Context(), 100, ['RATE_LIMIT', 'SERVER'])
    const next = vi.fn(async (): Promise<RequestErrorAction> => undefined)
    await escalator.listener(makePayload({ retryPolicy: { mode: 'always' } }), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('aborts at entry when the turn signal is already aborted, without recovering', async () => {
    const escalator = createEscalator(new Context(), 100, ['RATE_LIMIT', 'SERVER'])
    const controller = new AbortController()
    controller.abort()
    const next = vi.fn(async (): Promise<RequestErrorAction> => undefined)
    // A zero budget (with no recorded retries) passes the exhaustion gate and
    // reaches the aborted-fused check directly.
    const result = await escalator.listener(
      makePayload({ signal: controller.signal, retryPolicy: { mode: 'normal', maxRetries: 0 } }),
      next,
    )
    expect(result).toBeUndefined()
    expect(next).not.toHaveBeenCalled()
  })

  it('short-circuits a stale waterfall callback captured before disposal', async () => {
    const escalator = createEscalator(new Context(), 100, ['RATE_LIMIT', 'SERVER'])
    const next = vi.fn(async (): Promise<RequestErrorAction> => undefined)
    escalator.lifetime.abort()
    const result = await escalator.listener(makePayload(), next)
    expect(result).toBeUndefined()
    expect(next).not.toHaveBeenCalled()
  })

  it('registers and withdraws its empty runtime invariant', async () => {
    const ctx = new Context()
    const InvariantRegistry = (await import('@knyazevai/dsh-invariants')).default
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin((await import('../src/invariant.ts')))
    expect(() => ctx.invariants.register('@knyazevai/dsh-fork-llm-rate-limit-cooldown', () => {}))
      .toThrow(/already registered/u)
    await fiber.dispose()
    await expect(ctx.plugin((await import('../src/invariant.ts'))).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
