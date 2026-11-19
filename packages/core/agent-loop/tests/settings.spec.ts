/** The `agent-loop` settings section layered over the composition entry. */

import * as NativeToolExecutor from '@knyazevai/dsh-tool-executor-native'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@knyazevai/dsh-llm'
import SessionStore from '@knyazevai/dsh-session'
import SystemPrompt from '@knyazevai/dsh-system-prompt'
import ToolRuntime from '@knyazevai/dsh-tools'
import AgentRegistry from '@knyazevai/dsh-agent'
import SessionProjectionRegistry from '@knyazevai/dsh-session-projection'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import AgentLoop from '@knyazevai/dsh-agent-loop'

async function boot(maxParallelToolCalls?: number) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(NativeToolExecutor)
  const live = await liveConfig(ctx, AgentLoop, { agents: [], ...maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls } })
  return { ctx, live }

}

it('updates future scheduler budgets while preserving composed agents and the running loop', async () => {
  const { ctx, live } = await boot(4)
  const before = live.fiber
  await live.update({ maxParallelToolCalls: 1 })
  expect(live.entry.fiber === before).toBe(true)
  expect(ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(1)
  expect(ctx.agentLoop.config.agents).toEqual([])
  await expect(live.update({ maxParallelToolCalls: 0 })).rejects.toThrow()
  expect(ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(1)
})

it('defaults to ten and restores that default without remounting the loop', async () => {
  const { ctx, live } = await boot()
  const loop = ctx.agentLoop
  expect(loop.config.maxParallelToolCalls.get()).toBe(10)
  await live.update({ maxParallelToolCalls: 2 })
  expect(loop.config.maxParallelToolCalls.get()).toBe(2)
  await expect(live.update({ maxParallelToolCalls: 0 })).rejects.toThrow()
  await expect(live.update({ maxParallelToolCalls: 1.5 })).rejects.toThrow()
  expect(loop.config.maxParallelToolCalls.get()).toBe(2)
  await live.replace({ agents: [] })
  expect(loop.config.maxParallelToolCalls.get()).toBe(10)
  expect(ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10)
  expect(live.entry.fiber === live.fiber).toBe(true)
})
