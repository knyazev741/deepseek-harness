/** Buffered Chat Completions retain strict completion, tool validation, and cancellation. */
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler } from '@knyazevai/dsh-llm'
import type { StreamChunk } from '@knyazevai/dsh-llm'
import * as Retry from '@knyazevai/dsh-llm-retry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@knyazevai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@knyazevai/dsh-tool-testkit'
import { SessionId } from '@knyazevai/dsh-session'
import { createUserMessage } from '@knyazevai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(closeMockServers)

it.each([0, -1, 1.5, 2 ** 31])('rejects an invalid complete-response deadline %s', (completeResponseTimeoutMs) => {
  expect(() => resolveProfiles({ nvda: { api: 'openai-completions', baseURL: 'https://example.test/v1',
    models: [{ id: 'kimi' }], completeResponseTimeoutMs,
  } })).toThrow(/completeResponseTimeoutMs/)
})

it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('rejects an invalid buffer bound %s', (maxCompleteResponseBytes) => {
  expect(() => resolveProfiles({ nvda: { api: 'openai-completions', baseURL: 'https://example.test/v1',
    models: [{ id: 'kimi' }], maxCompleteResponseBytes,
  } })).toThrow(/maxCompleteResponseBytes/)
})

it.each(['anthropic-messages', 'openai-responses', 'google-generative-ai'] as const)('rejects buffered mode for %s', (api) => {
  expect(() => resolveProfiles({ nvda: { api, baseURL: 'https://example.test/v1',
    models: [{ id: 'kimi' }], streamResponses: false,
  } })).toThrow(/complete responses require openai-completions/)
})

function reply(message: Record<string, unknown> = { role: 'assistant', content: 'Complete answer.' }, finish: string | null = 'stop') {
  return JSON.stringify({ id: 'reply-one', object: 'chat.completion', created: 1, model: 'kimi',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  })
}

async function setup(behavior: Parameters<typeof mockServer>[0], config: Record<string, unknown> = {}) {
  const server = await mockServer(behavior)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.effect(() => ctx.llm.registerAdapter(['nvda'], new PiAiAdapter({
    profiles: () => resolveProfiles({ nvda: { api: 'openai-completions', baseURL: server.url,
      models: [{ id: 'kimi' }], ...config } }),
    resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth(),
  })))
  const collect = async (signal?: AbortSignal) => {
    const assembler = new BlockAssembler()
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'nvda', model: 'kimi', messages: [],
      ...signal === undefined ? {} : { signal },
    })) { assembler.push(chunk); chunks.push(chunk) }
    return { assembler, chunks }
  }
  return { ctx, server, collect }
}

it('keeps ordinary providers streaming by default', async () => {
  const { server, collect } = await setup([{ events: textEvents }])
  const { assembler } = await collect()
  expect(server.requests[0]).toMatchObject({ stream: true })
  expect(assembler.finish).toEqual({ kind: 'stop' })
})

it('requests a complete response and preserves text, usage, and the finish reason', async () => {
  const { server, collect } = await setup([{ body: reply() }], { streamResponses: false })
  const { assembler } = await collect()
  expect(server.requests[0]).toMatchObject({ stream: false })
  expect(server.requests[0]).not.toHaveProperty('stream_options')
  expect(assembler.finish).toEqual({ kind: 'stop' })
  expect(assembler.blocks()).toEqual([{ type: 'text', text: 'Complete answer.' }])
  expect(assembler.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, totalTokens: 16 })
})

it('assembles complete tool arguments through the existing provider decoder', async () => {
  const message = { role: 'assistant', content: null, reasoning_content: 'Use the tool.',
    tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'echo', arguments: '{"text":"ok"}' } }],
  }
  const { collect } = await setup([{ body: reply(message, 'tool_calls') }], { streamResponses: false })
  const { assembler } = await collect()
  expect(assembler.finish).toEqual({ kind: 'tool-calls' })
  expect(assembler.blocks()).toContainEqual({ type: 'tool-call', id: 'call-one', name: 'echo', arguments: '{"text":"ok"}' })
})

it('rejects malformed arguments before tool dispatch', async () => {
  const message = { role: 'assistant', content: null,
    tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'echo', arguments: '{"text":' } }],
  }
  const { collect } = await setup([{ body: reply(message, 'tool_calls') }], { streamResponses: false })
  const { assembler } = await collect()
  expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } })
})

it('refuses an unconfirmed complete response even with legacy finish inference enabled', async () => {
  const { collect } = await setup([{ body: reply(undefined, null) }], {
    streamResponses: false, compat: { supportsFinishReason: false },
  })
  const { assembler } = await collect()
  expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'STREAM_CLOSED' } })
})

it('bounds the buffered response bytes', async () => {
  const { collect } = await setup([{ body: reply() }], { streamResponses: false, maxCompleteResponseBytes: 32 })
  const { assembler } = await collect()
  expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } })
})

it('keeps provider rate limits available to retry policy', async () => {
  const { collect } = await setup([{ status: 429, body: '{"error":{"message":"rate limit"}}' }], { streamResponses: false })
  const { assembler } = await collect()
  expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })
})

it('cancels a pending complete response and closes its connection', async () => {
  const { server, collect } = await setup([{ events: [], holdOpen: true }], { streamResponses: false })
  const controller = new AbortController()
  const result = collect(controller.signal)
  await server.requestReceived
  controller.abort()
  const { assembler } = await result
  expect(assembler.finish.kind).toBe('aborted')
  await server.responseClosed
})

it('keeps always-retry recovery across tool rounds without replaying a successful tool', async () => {
  const failure = { status: 429, body: '{"error":{"message":"rate limit"}}' }
  const tool = { role: 'assistant', content: null,
    tool_calls: [{ id: 'call-count', type: 'function', function: { name: 'count', arguments: '{}' } }],
  }
  const server = await mockServer([
    ...Array.from({ length: 7 }, () => failure),
    { body: reply(undefined, null) },
    { body: reply(tool, 'tool_calls') },
    ...Array.from({ length: 3 }, () => failure),
    { body: reply() },
  ])
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Retry)
  ctx.effect(() => ctx.llm.registerAdapter(['nvda'], new PiAiAdapter({
    profiles: () => resolveProfiles({ nvda: {
      api: 'openai-completions', baseURL: server.url, models: [{ id: 'kimi' }], streamResponses: false,
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
    } }),
    resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth(),
  })))
  let executions = 0
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'count', description: 'Count executions', parameters: {}, isConcurrencySafe: () => true,
    async execute() { executions++; return [{ type: 'text', text: 'counted-once' }] },
  })))
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId('complete-response-retry'), { provider: 'nvda', model: 'kimi' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Count then finish.' }] }))
  await agent.whenIdle()
  expect(executions).toBe(1)
  expect(server.requests).toHaveLength(13)
  expect(server.requests.every(request => typeof request === 'object' && request !== null && 'stream' in request && request.stream === false)).toBe(true)
  expect(JSON.stringify(server.requests.at(-1))).toContain('counted-once')
  const events = agent.session.snapshotEvents()
  const retries = events.flatMap(event => event.type === 'llm/retry' ? [event.data] : [])
  expect(retries).toHaveLength(11)
  expect(retries.every(event => event.mode === 'always' && !('maxRetries' in event))).toBe(true)
  expect(retries.map(event => event.failure.code)).toEqual([
    ...Array.from({ length: 7 }, () => 'RATE_LIMIT'), 'STREAM_CLOSED',
    ...Array.from({ length: 3 }, () => 'RATE_LIMIT'),
  ])
  expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
  expect(events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
})
