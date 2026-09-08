import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId, SessionStore } from '@knyazevai/dsh-session'
import { SessionProjectionRegistry } from '@knyazevai/dsh-session-projection'
import * as ForkSessionSource from '../src/index.ts'
import { forkSessionSourceProjectionDefinition } from '../src/projection.ts'
import type { ForkSessionSource as ForkSessionSourceValue } from '../src/types.ts'

const activeContexts: Context[] = []
let loaderRoot: string | undefined

afterEach(async () => {
  await Promise.all(activeContexts.splice(0).map(context => context.fiber.dispose()))
  if (loaderRoot !== undefined) await rm(loaderRoot, { recursive: true, force: true })
  loaderRoot = undefined
  vi.unstubAllEnvs()
})

async function createHarness(config: ForkSessionSource.Config = { enabledWhenEnv: 'GITHUB_ACTIONS' }) {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(ForkSessionSource, config)
  return { ctx, fiber }
}

describe('fork session source projection', () => {
  it('starts at null, keeps the last marker, and ignores unrelated events', () => {
    const initial: ForkSessionSourceValue = forkSessionSourceProjectionDefinition.init()
    const marker = {
      type: 'fork/session-source',
      data: { source: 'github-actions' },
    } as const
    const unrelated = {
      type: 'session/title',
      data: { title: 'unrelated' },
    } as const
    const applyProjection = forkSessionSourceProjectionDefinition.apply

    expect(initial).toBeNull()
    const afterMarker = applyProjection(initial, marker as never)
    expect(afterMarker).toBe('github-actions')
    expect(applyProjection(afterMarker, unrelated as never)).toBe(afterMarker)
    expect(applyProjection(afterMarker, marker as never)).toBe('github-actions')
    expect(forkSessionSourceProjectionDefinition.wire.view(afterMarker)).toBe('github-actions')
  })

  it('rejects malformed durable marker payloads while folding', () => {
    const malformed = {
      type: 'fork/session-source',
      data: { source: 'unknown' },
    } as const

    const applyProjection = forkSessionSourceProjectionDefinition.apply
    expect(() => applyProjection(null, malformed as never)).toThrow()
  })
})

describe('fork session source plugin', () => {
  it('defaults the environment key and rejects an empty key', () => {
    expect(ForkSessionSource.Config()).toEqual({ enabledWhenEnv: 'GITHUB_ACTIONS' })
    expect(() => ForkSessionSource.Config({ enabledWhenEnv: '' })).toThrow()
  })

  it('appends one ignorable marker when the configured environment is true', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const { ctx } = await createHarness()
    const session = ctx.sessions.create(SessionId('source-enabled'))

    const markers = session.events.filter(event => event.type === 'fork/session-source')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({
      data: { source: 'github-actions' },
      ignorable: true,
    })
    expect(session.header).not.toHaveProperty('origin')
    expect(ctx.sessionProjections.snapshot(session).values.forkSessionSource).toBe('github-actions')
  })

  it('does not append when the configured environment is not true', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'false')
    const { ctx } = await createHarness()
    const session = ctx.sessions.create(SessionId('source-disabled'))

    expect(session.events.some(event => event.type === 'fork/session-source')).toBe(false)
    expect(ctx.sessionProjections.snapshot(session).values.forkSessionSource).toBeNull()
  })

  it('uses a configured environment key and does not duplicate a persisted marker', async () => {
    vi.stubEnv('CUSTOM_SOURCE_KEY', 'true')
    const { ctx } = await createHarness({ enabledWhenEnv: 'CUSTOM_SOURCE_KEY' })
    const original = ctx.sessions.create(SessionId('source-original'))
    const replay = ctx.sessions.create(SessionId('source-replay'), {
      seed: original.events,
    })

    expect(replay.events.filter(event => event.type === 'fork/session-source')).toHaveLength(1)
  })

  it('removes the append listener and projection registration on disposal', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const { ctx, fiber } = await createHarness()
    await fiber.dispose()
    const session = ctx.sessions.create(SessionId('source-disposed'))

    expect(session.events.some(event => event.type === 'fork/session-source')).toBe(false)
    expect(ctx.sessionProjections.snapshot(session).values.forkSessionSource).toBeUndefined()
  })
})

describe('fork session source loader composition', () => {
  it('loads through Cordis Loader with the projection and append behavior', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-session-source-loader-'))
    loaderRoot = root
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@knyazevai/dsh-session'",
      "- name: '@knyazevai/dsh-session-projection'",
      "- name: '@knyazevai/dsh-fork-session-source'",
      '',
    ].join('\n'))
    const ctx = new Context()
    activeContexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const modules = new Map<string, unknown>([
          ['@knyazevai/dsh-session', SessionStore],
          ['@knyazevai/dsh-session-projection', SessionProjectionRegistry],
          ['@knyazevai/dsh-fork-session-source', ForkSessionSource],
        ])
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    const session = ctx.sessions.create(SessionId('loader-composition'))

    expect(session.events.some(event => event.type === 'fork/session-source')).toBe(true)
    expect(ctx.sessionProjections.snapshot(session).values.forkSessionSource).toBe('github-actions')
  })
})
