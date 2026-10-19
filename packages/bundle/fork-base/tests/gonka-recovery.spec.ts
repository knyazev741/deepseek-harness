/** Gonka's shipped retry policy retains requests through provider outages. */
import { readFileSync } from 'node:fs'
import { onTestFinished, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@knyazevai/dsh-agent'
import AgentLoop from '@knyazevai/dsh-agent-loop'
import type { Agent } from '@knyazevai/dsh-agent'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy, ToolCallId } from '@knyazevai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from '@knyazevai/dsh-llm'
import * as retry from '@knyazevai/dsh-llm-retry'
import SessionStore, { SessionId } from '@knyazevai/dsh-session'
import SessionProjectionRegistry from '@knyazevai/dsh-session-projection'
import SystemPrompt from '@knyazevai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@knyazevai/dsh-tools'

type Response = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

function shippedPolicy(): ResolvedRetryPolicy {
  const rows = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as { id?: string; config?: { providers: Record<string, { retryPolicy?: RetryPolicyConfig }> } }[]
  return resolveRetryPolicy(rows.find(row => row.id === 'llm-pi-ai')!.config!.providers['knyazev-ai']!.retryPolicy, 'Gonka bundle retryPolicy')
}

class RecoveringAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly responses: Response[], private readonly policy = shippedPolicy()) {
    super()
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Gonka recovery fixture exhausted')
    if (response instanceof Error) throw response
    yield* response
  }
}

function reply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(responses: Response[]): Promise<{ ctx: Context; agent: Agent; adapter: RecoveringAdapter }> {
  const ctx = new Context()
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
  vi.useFakeTimers()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(retry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new RecoveringAdapter(responses)
  ctx.effect(() => ctx.llm.registerAdapter(['knyazev-ai'], adapter))
  const agent = await ctx.agentLoop.create(SessionId('gonka-recovery'), { provider: 'knyazev-ai', model: 'deepseek-v4-flash' })
  return { ctx, agent, adapter }
}

function start(agent: Agent): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Finish the task after the provider recovers.' }], source: { kind: 'user' } }))
}

const failureCodes = ['RATE_LIMIT', 'SERVER', 'QUOTA', 'TIMEOUT', 'FIRST_CHUNK_TIMEOUT', 'TRANSPORT',
  'PI_AI_ERROR', 'STREAM_CLOSED', 'EMPTY_RESPONSE', 'AUTH', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED']

describe('Gonka shipped persistent recovery', () => {
  it.each(failureCodes)('finishes after 45 consecutive %s failures with no ten-minute waits', async (code) => {
    const { agent, adapter } = await harness([
      ...Array.from({ length: 45 }, () => new LlmError('provider unavailable', code)), reply('done'),
    ])
    start(agent)
    await vi.advanceTimersByTimeAsync(450_000)
    expect(adapter.requests).toHaveLength(46)
    await agent.whenIdle()
    const waits = agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
    expect(waits).toHaveLength(45)
    for (const wait of waits) {
      expect(wait.data.mode).toBe('always')
      expect(wait.data.delayMs).toBeGreaterThan(0)
      expect(wait.data.delayMs).toBeLessThanOrEqual(10_000)
      expect(wait.data).not.toHaveProperty('maxRetries')
    }
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({ content: [{ type: 'text', text: 'done' }] })
  })

  it('keeps a completed tool result while retrying the next model request', async () => {
    const id = ToolCallId('once')
    const toolCall: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name: 'once', argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'once', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const { ctx, agent, adapter } = await harness([
      toolCall, ...Array.from({ length: 25 }, () => new LlmError('connection closed', 'STREAM_CLOSED')), reply('done'),
    ])
    let executions = 0
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'once', description: 'Record one completed operation.', parameters: {},
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'operation completed' }]
      },
    })))
    start(agent)
    await vi.advanceTimersByTimeAsync(250_000)
    expect(adapter.requests).toHaveLength(27)
    await agent.whenIdle()
    expect(executions).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
    for (const request of adapter.requests.slice(1)) expect(request.messages.some(message => message.role === 'tool')).toBe(true)
  })

  it('retries a failed partial tool stream without executing it', async () => {
    const id = ToolCallId('discarded')
    async function* interrupted(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'once', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'once', arguments: '{}' } }
      throw new LlmError('stream interrupted', 'TRANSPORT')
    }
    const { agent, adapter } = await harness([interrupted(), reply('done')])
    start(agent)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(adapter.requests).toHaveLength(2)
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/call')).toBe(false)
  })

  it('stops retrying immediately when the user cancels', async () => {
    const { ctx, agent, adapter } = await harness([new LlmError('overloaded', 'RATE_LIMIT'), reply('must not run')])
    const scheduled = new Promise<void>((resolve) => {
      ctx.on('session/event', (_session, event) => { if (event.type === 'llm/retry') resolve() })
    })
    start(agent)
    await scheduled
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(adapter.requests).toHaveLength(1)
  })
})
