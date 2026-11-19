import { executeToolFixture } from '@knyazevai/dsh-tool-testkit'
import * as NativeToolExecutor from '@knyazevai/dsh-tool-executor-native'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@knyazevai/dsh-system-prompt'
import ToolRuntime from '@knyazevai/dsh-tools'
import { brandString } from '@knyazevai/dsh-brand'
import type { ToolCallId } from '@knyazevai/dsh-llm/types'
import McpResources from '@knyazevai/dsh-mcp-resources'
import { createScope } from '@knyazevai/dsh-scope'
import { registerServerContext } from '../src/server-context.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(McpResources)
  return ctx
}

describe('MCP server context', () => {
  it('publishes literal instructions and withdraws the prompt and resource provider together', async () => {
    const ctx = await setup()
    let instructions = 'MCP server: docs\nKeep {{server.template}} literal.'
    const fiber = await ctx.plugin({ apply(inner: Context) {
      registerServerContext(inner, 'docs', {
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => instructions,
      })
    } })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(instructions)
    instructions = 'MCP server: docs\nUpdated instructions.'
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(instructions)
    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP server: docs')
    const result = await executeToolFixture(ctx, {
      name: 'list_mcp_resources', arguments: { server: 'docs' },
      callId: brandString<ToolCallId>('disposed-resource'), signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
  })

  it('shows scoped server instructions only to the owning scope', async () => {
    const ctx = await setup()
    const scopeKey = {}
    await ctx.plugin({ apply(inner: Context) {
      const scoped = createScope(inner, scopeKey)
      registerServerContext(scoped.ctx, 'private', {
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => 'Private server instructions.',
      })
    } })
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKey }))).toContain('Private server instructions.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Private server instructions.')
  })
})
