import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@knyazevai/dsh-session'
import { SettingsProvider } from '@knyazevai/dsh-settings'
import { remoteMethods } from '@knyazevai/dsh-typert-protocol'
import ForkWorkspaceSessionState from '../src/index.ts'

const SETTINGS = '@fixture/settings'
const WORKSPACE = '@fixture/workspace'
const STATE = '@knyazevai/dsh-fork-workspace-session-state'
const contexts: Context[] = []
const roots: string[] = []

class MemorySettings extends SettingsProvider {
  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected persist(): Promise<void> {
    return Promise.resolve()
  }
}

class FixtureWorkspaceRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  list(): readonly { readonly sessionIds: readonly SessionId[] }[] {
    return [{ sessionIds: [SessionId('loader-session')] }]
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('fork workspace session state through a real Loader composition', () => {
  it('mounts and removes the service and its Remote marker with the Loader entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-workspace-session-state-loader-'))
    roots.push(root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      `- name: '${SETTINGS}'`,
      `- name: '${WORKSPACE}'`,
      `- name: '${STATE}'`,
      '',
    ].join('\n'))

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      [SETTINGS, MemorySettings],
      [WORKSPACE, FixtureWorkspaceRegistry],
      [STATE, ForkWorkspaceSessionState],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>

    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    await expect(ctx.forkWorkspaceSessionState.list()).resolves.toEqual({
      revision: 0,
      pinnedSessionIds: [],
    })
    expect(remoteMethods(ctx.forkWorkspaceSessionState).map(marker => marker.method))
      .toEqual(['list', 'setPinned'])

    const stateEntry = [...ctx.loader.entries()].find(entry => entry.options.name === STATE)
    if (stateEntry === undefined) throw new Error(`Loader did not mount ${STATE}`)
    stateEntry.parent.remove(stateEntry.options.id)
    expect(ctx.get('forkWorkspaceSessionState')).toBeUndefined()
  })
})
