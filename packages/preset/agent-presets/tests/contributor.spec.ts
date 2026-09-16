import SessionProjectionRegistry from '@knyazevai/dsh-session-projection'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@knyazevai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@knyazevai/dsh-session'
import SystemPrompt from '@knyazevai/dsh-system-prompt'
import ToolRuntime from '@knyazevai/dsh-tools'
import AgentRegistry, { type Agent } from '@knyazevai/dsh-agent'
import AgentLoop from '@knyazevai/dsh-agent-loop'
import { beforeEach, describe, expect, it } from 'vitest'
import AgentPresets, {
  AGENT_PRESET_PATCH_CONTRIBUTOR,
  type AgentPresetPatchContribution,
  type AgentPresetPatchContributor,
} from '@knyazevai/dsh-agent-presets'
import type { Config } from '@knyazevai/dsh-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [
  { path: join(FIXTURES, 'system'), trust: 'system' as const },
  { path: join(FIXTURES, 'user'), trust: 'user' as const },
]

/** Boot the existing preset service with the fixture roster. */
async function harness(roster: Config = { default: 'standard', roots: ROOTS, includeShippedRoot: false, includeUserRoot: false }): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, roster)
  return ctx
}

/** Create one agent through the same setup hook used by production factories. */
async function agentOn(ctx: Context, id: string, presetId?: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

/** Join a child to its parent's exact standing generation. */
async function childOf(ctx: Context, id: string, parent: Agent): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: (childCtx: Context) => void ctx.agentPresets.composeFrom(childCtx, parent.ctx),
  })
  return handle.agent
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

/** Read the cross-package registry without coupling this test to service internals. */
function contributor(ctx: Context): AgentPresetPatchContributor {
  return ctx.agentPresets[AGENT_PRESET_PATCH_CONTRIBUTOR]
}

/** Register a patch through a disposable plugin owner. */
async function ownedRegistration(
  ctx: Context,
  ...contributions: AgentPresetPatchContribution[]
): Promise<Fiber> {
  return await ctx.plugin(Object.assign((inner: Context) => {
    const api = inner.agentPresets[AGENT_PRESET_PATCH_CONTRIBUTOR]
    for (const contribution of contributions) api.register(contribution)
  }, { inject: ['agentPresets'] }))
}

describe('agent preset patch contributions', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await harness()
  })

  it('applies contributions in registration order and disposes them with the owner', async () => {
    const owner = await ownedRegistration(
      ctx,
      { presetId: 'standard', patches: [{ id: 'alpha', config: { tool: 'first' } }] },
      { presetId: 'standard', patches: [{ id: 'alpha', config: { tool: 'second' } }] },
    )

    const joined = await agentOn(ctx, 'contributor-order', 'standard')
    expect(toolNames(ctx, joined)).toEqual(['second'])

    await owner.dispose()

    const afterDispose = await agentOn(ctx, 'contributor-disposed', 'standard')
    expect(toolNames(ctx, afterDispose)).toEqual(['alpha'])
  })

  it('isolates contributions to their target preset', async () => {
    const owner = await ownedRegistration(ctx, {
      presetId: 'standard',
      patches: [{ id: 'alpha', config: { tool: 'standard-patched' } }],
    })

    const standard = await agentOn(ctx, 'contributor-standard', 'standard')
    const minimal = await agentOn(ctx, 'contributor-minimal', 'minimal')

    expect(toolNames(ctx, standard)).toEqual(['standard-patched'])
    expect(toolNames(ctx, minimal)).toEqual(['beta'])
    await owner.dispose()
  })

  it('accepts a contribution for a missing preset until that preset is resolved', async () => {
    expect(() => contributor(ctx).register({
      presetId: 'not-installed',
      patches: [{ id: 'anything', config: {} }],
    })).not.toThrow()

    await expect(ctx.agentPresets.resolve('not-installed')).rejects.toThrow(/not found/)
  })

  it('keeps already joined sessions and composeFrom children on their generation', async () => {
    const parent = await agentOn(ctx, 'contributor-parent', 'standard')
    const child = await childOf(ctx, 'contributor-child', parent)

    contributor(ctx).register({
      presetId: 'standard',
      patches: [{ id: 'alpha', config: { tool: 'later-generation' } }],
    })

    const later = await agentOn(ctx, 'contributor-later', 'standard')

    expect(toolNames(ctx, parent)).toEqual(['alpha'])
    expect(toolNames(ctx, child)).toEqual(['alpha'])
    expect(toolNames(ctx, later)).toEqual(['later-generation'])
  })

  it('copies patches before registration so later caller mutation cannot change a mount', async () => {
    const patches = [{ id: 'alpha', config: { tool: 'copied' } }]
    contributor(ctx).register({ presetId: 'standard', patches })
    patches[0]!.config.tool = 'mutated'

    const agent = await agentOn(ctx, 'contributor-copy', 'standard')
    expect(toolNames(ctx, agent)).toEqual(['copied'])
  })

  it('supports explicit disposal of a contribution', async () => {
    const dispose = contributor(ctx).register({
      presetId: 'standard',
      patches: [{ id: 'alpha', config: { tool: 'temporary' } }],
    })
    dispose()
    dispose()

    const agent = await agentOn(ctx, 'contributor-manual-dispose', 'standard')
    expect(toolNames(ctx, agent)).toEqual(['alpha'])
  })

  it('ignores unrelated session events', () => {
    const selected: string[] = []
    ctx.on('agent-preset/selected', (_sessionId, presetId) => selected.push(presetId))
    const session = ctx.sessions.create(SessionId('contributor-unrelated-event'))
    const event: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 0 } }

    ctx.emit('session/event', session, event)

    expect(selected).toEqual([])
  })

  it('rejects empty preset ids and patch lists', () => {
    expect(() => contributor(ctx).register({ presetId: ' ', patches: [{ id: 'alpha' }] }))
      .toThrow(/preset id.*non-empty/i)
    expect(() => contributor(ctx).register({ presetId: 'standard', patches: [] }))
      .toThrow(/patch.*non-empty/i)
  })
})
