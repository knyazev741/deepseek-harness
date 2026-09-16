import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId, createUserMessage, ReasoningEffortId } from '@knyazevai/dsh-llm'
import * as LlmPiAi from '@knyazevai/dsh-llm-pi-ai'
import type { Config } from '@knyazevai/dsh-llm-pi-ai'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe.skipIf(!process.env.KNYAZEV_AI_API_KEY)('fork GLM real API', () => {
  it('streams a tool call and replays its result with the shipped provider configuration', async () => {
    const rows = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as { id?: string; config?: Config }[]
    const config = rows.find(row => row.id === 'llm-pi-ai')?.config
    expect(config).toBeDefined()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, config)
    const messages = [createUserMessage({
      content: [{ type: 'text', text: 'Use get_weather to check weather in Bali.' }],
      source: { kind: 'plugin', plugin: 'test' },
    })]
    const tools = [{
      name: 'get_weather',
      description: 'Get the current weather in a city.',
      parameters: { type: 'object' as const, properties: { city: { type: 'string' } }, required: ['city'] },
    }]
    const options = { provider: 'knyazev-ai', model: 'glm-5.3-flash', reasoningEffort: ReasoningEffortId('high'), maxTokens: 512, tools }
    const first = await assemble(ctx, { ...options, messages })
    expect(first.finish.kind).toBe('tool-calls')
    const call = first.message.content.find(block => block.type === 'tool-call')
    if (!call || call.type !== 'tool-call') throw new Error('GLM did not return a tool call')
    expect(call.name).toBe('get_weather')
    expect(JSON.parse(call.arguments)).toMatchObject({ city: expect.stringMatching(/bali/i) as string })
    const second = await assemble(ctx, {
      ...options,
      messages: [...messages, first.message, createUserMessage({
        content: [{ type: 'tool-result', toolCallId: ToolCallId(call.id), content: [{ type: 'text', text: 'Bali: sunny, 28 C.' }] }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(second.finish.kind).toBe('stop')
    const text = second.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text.toLowerCase()).toMatch(/sunny|28/)
    expect(second.usage?.outputTokens).toBeGreaterThan(0)
  })
})
