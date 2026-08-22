import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  assertEntriesLoaded,
  healProfilesModuleFallback,
  loadOverlayPatches,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import * as webApp from '@deepseek-ai/dsh-web-app'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const installAnchor = resolve(root, 'apps/cli/package.json')
const basePatchPath = resolve(root, 'packages/bundle/base/cordis.patch.yml')
const webPatchPath = resolve(root, 'packages/bundle/web-app/cordis.patch.yml')
const codexPatchPath = resolve(root, 'packages/bundle/web-codex/cordis.patch.yml')

interface Booted {
  readonly context: Context
  readonly root: string
  readonly restore: () => void
}

interface PatchEntry {
  readonly name?: string
  readonly config?: Record<string, unknown>
}

/** Source locations let this direct Loader test exercise a fresh checkout before a full build. */
const workspacePackages = new Map<string, string>()
function collectPackageDirs(directory: string): void {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name.startsWith('.')) continue
    const path = join(directory, item.name)
    if (!item.isDirectory()) continue
    const manifestPath = join(path, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
      if (manifest.name !== undefined) workspacePackages.set(manifest.name, path)
    }
    collectPackageDirs(path)
  }
}
collectPackageDirs(join(root, 'packages'))

/** Resolve a workspace plugin row to its TypeScript source entry. */
function workspaceSource(specifier: string): string | undefined {
  const parts = specifier.split('/')
  const packageName = parts.slice(0, 2).join('/')
  const packageDir = workspacePackages.get(packageName)
  if (packageDir === undefined) return undefined
  const relative = parts.length === 2 ? 'src/index.ts' : `src/${parts.slice(2).join('/')}.ts`
  const source = join(packageDir, relative)
  return existsSync(source) ? pathToFileURL(source).href : undefined
}

/** Return rows introduced by one patch layer for static bundle assertions. */
function insertedRows(patches: readonly PatchOptions[]): PatchEntry[] {
  return patches.flatMap((patch) => {
    const insert = (patch as { readonly insert?: unknown }).insert
    return Array.isArray(insert) ? insert as PatchEntry[] : []
  })
}

const booted: Booted[] = []

afterEach(async () => {
  for (const item of booted.splice(0)) {
    await item.context.fiber.dispose()
    item.restore()
    await rm(item.root, { recursive: true, force: true })
  }
})

/** Harness-only rows that keep a real Web Loader boot hermetic and keyless. */
function harnessPatches(tempRoot: string): PatchOptions[] {
  return [
    { id: 'session-persistence-jsonl', config: { root: join(tempRoot, 'sessions') } },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'agent-instructions', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'web-runtime', config: { printUrl: false, surfaceContext: false, trustedHosts: [] } },
    // This composition assertion is host/provider-focused; client bundle assembly is
    // covered by the build gate and does not belong to a fresh source-tree Loader boot.
    { id: 'modules', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
  ]
}

/** Boot the actual bundle patches through Cordis Loader and return its settled context. */
async function bootComposition(optIn: boolean, missingSpecifier?: string): Promise<Context> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-web-codex-loader-'))
  const harnessHome = join(tempRoot, '.dsh-home')
  const profileRoot = join(harnessHome, 'profiles', 'composition')
  await mkdir(profileRoot, { recursive: true })
  const rootConfig = join(profileRoot, 'cordis.yml')
  const frontendIndex = join(tempRoot, 'index.html')
  await writeFile(rootConfig, '[]\n')
  await writeFile(frontendIndex, '<!doctype html><title>Loader composition</title>\n')

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = harnessHome
  const previousDist = webApp.internals.resolveDistIndex
  webApp.internals.resolveDistIndex = () => frontendIndex

  const context = new Context()
  booted.push({
    context,
    root: tempRoot,
    restore: () => {
      webApp.internals.resolveDistIndex = previousDist
      if (previousHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
      else process.env.DSH_HOME = previousHome
    },
  })
  healProfilesModuleFallback(installAnchor, harnessHome)
  context.baseUrl = pathToFileURL(profileRoot).href + '/'
  context.provide('dshHomePath', dshHomePath)
  provideCmdline(context, {
    args: [],
    exit: (code) => { throw new Error(`composition unexpectedly requested exit ${String(code)}`) },
  })
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.builtins.group = Group
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === missingSpecifier) throw new Error(`missing provider dependency: ${specifier}`)
      const source = workspaceSource(specifier)
      const module: unknown = await import(source ?? specifier)
      return module
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  const patches = [
    ...loadOverlayPatches('web-codex composition', basePatchPath),
    ...loadOverlayPatches('web-codex composition', webPatchPath),
    ...(optIn ? loadOverlayPatches('web-codex composition', codexPatchPath) : []),
    ...harnessPatches(tempRoot),
  ]
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(rootConfig).href, patches },
  })
  await context.loader.await()
  assertEntriesLoaded(context, 'web-codex composition')
  return context
}

describe('web-codex bundle composition', () => {
  it('boots the shipped default Web tree without an external provider', async () => {
    const context = await bootComposition(false)
    const names = [...context.loader.entries()].map(entry => entry.options.name)
    expect(names).not.toContain('@deepseek-ai/dsh-external-session-codex')
    expect(context.get('externalSessions')).toBeUndefined()
  })

  it('boots base + Web + web-codex and discovers every required provider row once', async () => {
    const patchText = readFileSync(codexPatchPath, 'utf8')
    const optInRows = insertedRows(loadOverlayPatches('web-codex composition', codexPatchPath))
    const manifest = JSON.parse(readFileSync(resolve(root, 'packages/bundle/web-codex/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(patchText).not.toMatch(/(?:API_KEY|TOKEN|PASSWORD|SECRET)/u)
    const context = await bootComposition(true)
    const names = [...context.loader.entries()].map(entry => entry.options.name)
    const required = [
      '@deepseek-ai/dsh-external-session',
      '@deepseek-ai/dsh-external-permission',
      '@deepseek-ai/dsh-external-session-codex',
      '@deepseek-ai/dsh-external-session-bridge',
      '@deepseek-ai/dsh-mcp-gateway',
    ]

    for (const name of required) {
      expect(optInRows.filter(row => row.name === name)).toHaveLength(1)
      expect(manifest.dependencies).toHaveProperty(name)
      expect(names.filter(candidate => candidate === name)).toHaveLength(1)
    }
    expect(optInRows.find(row => row.name === '@deepseek-ai/dsh-external-session-codex')?.config).toMatchObject({
      args: ['app-server', '--stdio'],
      allowedTools: [],
      disposeGraceMs: 3000,
      preflightTimeoutMs: 30000,
    })
    expect(optInRows.find(row => row.name === '@deepseek-ai/dsh-mcp-gateway')?.config).toMatchObject({
      allowlist: [],
      maxRequestBytes: 65536,
      maxResponseBytes: 65536,
      executionTimeoutMs: 60000,
    })
    const external = context.get('externalSessions')
    if (external === undefined) throw new Error('web-codex Loader boot did not provide externalSessions')
    expect(external.listAgents()).toEqual([
      { provider: 'codex', label: 'Codex', modelDirectory: 'provider' },
    ])
  })

  it('fails loudly when the Codex provider dependency cannot be imported', async () => {
    await expect(bootComposition(true, '@deepseek-ai/dsh-external-session-codex'))
      .rejects.toThrow('missing provider dependency: @deepseek-ai/dsh-external-session-codex')
  })
})
