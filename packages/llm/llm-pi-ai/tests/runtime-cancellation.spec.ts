import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, type StreamChunk } from '@knyazevai/dsh-llm'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(closeMockServers)

it.each([true, false])('closes the abandoned HTTP request before recovery with streamResponses=%s', async (streamResponses) => {
  const server = await mockServer([{ holdOpen: true }, {
    ...(streamResponses ? { events: textEvents } : {
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] }),
    }),
  }])
  const ctx = new Context()
  const caller = new AbortController()
  let pending: Promise<IteratorResult<StreamChunk>> | undefined
  let downstream: AsyncIterator<StreamChunk> | undefined
  onTestFinished(async () => {
    caller.abort()
    await pending
    await downstream?.return?.()
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  ctx.effect(() => ctx.llm.registerAdapter(['nvda'], new PiAiAdapter({
    profiles: () => resolveProfiles({ nvda: {
      api: 'openai-completions', baseURL: server.url, models: [{ id: 'kimi' }], streamResponses,
    } }),
    resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth(),
  })))
  const dispose = ctx.on('llm/stream', (_options, next) => ({
    async * [Symbol.asyncIterator]() {
      const iterator = next()[Symbol.asyncIterator]()
      downstream = iterator
      pending = iterator.next()
      await server.requestReceived
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'FIRST_CHUNK_TIMEOUT', message: 'first chunk timed out' } },
      } satisfies StreamChunk
    },
  }))
  const collect = async () => {
    const result = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'nvda', model: 'kimi', messages: [], signal: caller.signal,
    })) result.push(chunk)
    return result
  }
  expect((await collect()).finish).toEqual({
    kind: 'error', failure: { code: 'FIRST_CHUNK_TIMEOUT', message: 'first chunk timed out' },
  })
  await server.responseClosed
  expect(caller.signal.aborted).toBe(false)
  expect(server.closedResponses).toBe(1)
  dispose()

  expect((await collect()).finish).toEqual({ kind: 'stop' })
  expect(server.requests).toHaveLength(2)
})
