/** Shipped GLM reasoning levels and their actual Chat Completions payload. */
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@knyazevai/dsh-llm'
import * as LlmPiAi from '@knyazevai/dsh-llm-pi-ai'
import type { Config } from '@knyazevai/dsh-llm-pi-ai'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'
import { closeMockServers, mockServer, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

it('sends low, high and max instead of an on/off flag and rejects off for GLM', async () => {
  const rows = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as { id?: string; config?: Config }[]
  const config = rows.find(row => row.id === 'llm-pi-ai')!.config!
  const server = await mockServer(['low', 'high', 'max'].map(() => ({ events: textEvents })))
  vi.stubEnv('KNYAZEV_AI_API_KEY', 'keyless-glm-wire-test')
  config.providers!['knyazev-ai']!.baseURL = `${server.url}/v1`
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, config)
  for (const effort of ['low', 'high', 'max']) {
    const result = await assemble(ctx, {
      provider: 'knyazev-ai', model: 'glm-5.3-flash',
      reasoningEffort: ReasoningEffortId(effort), messages: [],
    })
    expect(result.finish.kind).toBe('stop')
    expect(server.requests.at(-1)).toMatchObject({ model: 'glm-5.3-flash', reasoning_effort: effort })
    expect(server.requests.at(-1)).not.toHaveProperty('enable_thinking')
  }
  await expect(assemble(ctx, {
    provider: 'knyazev-ai', model: 'glm-5.3-flash', reasoningEffort: ReasoningEffortId('off'), messages: [],
  })).resolves.toMatchObject({ finish: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } } })
})

it('sends an explicit off value for DeepSeek because the API defaults to thinking', async () => {
  const rows = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as { id?: string; config?: Config }[]
  const config = rows.find(row => row.id === 'llm-pi-ai')!.config!
  const server = await mockServer([{ events: textEvents }])
  vi.stubEnv('KNYAZEV_AI_API_KEY', 'keyless-deepseek-wire-test')
  config.providers!['knyazev-ai']!.baseURL = `${server.url}/v1`
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, config)

  const result = await assemble(ctx, {
    provider: 'knyazev-ai', model: 'deepseek-v4-flash',
    reasoningEffort: ReasoningEffortId('off'), messages: [],
  })

  expect(result.finish.kind).toBe('stop')
  expect(server.requests.at(-1)).toMatchObject({
    model: 'deepseek-v4-flash',
    reasoning_effort: 'off',
  })
})
