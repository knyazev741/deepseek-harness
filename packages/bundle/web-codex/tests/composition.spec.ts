import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

interface Entry {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

const root = fileURLToPath(new URL('../../../..', import.meta.url))

function rows(file: string): Entry[] {
  const parsed = patches(file)
  return parsed.flatMap((patch) => {
    const insert = (patch as { insert?: unknown }).insert
    return Array.isArray(insert) ? insert as Entry[] : []
  })
}

function patches(file: string): PatchOptions[] {
  const parsed = yaml.load(readFileSync(resolve(root, file), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError(`${file} must contain a Loader patch list`)
  return parsed as PatchOptions[]
}

describe('web-codex bundle composition', () => {
  it('keeps Codex absent from default Web and mounts each opt-in row once', async () => {
    const basePatches = patches('packages/bundle/base/cordis.patch.yml')
    const webPatches = patches('packages/bundle/web-app/cordis.patch.yml')
    const defaultRows = [...rows('packages/bundle/base/cordis.patch.yml'), ...rows('packages/bundle/web-app/cordis.patch.yml')]
    const defaultComposition = composeEntries([basePatches, webPatches])
    expect(defaultRows.some(row => row.name === '@deepseek-ai/dsh-external-session-codex')).toBe(false)
    expect(defaultComposition.some(row => row.name === '@deepseek-ai/dsh-external-session-codex')).toBe(false)

    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const optInPatches = patches('packages/bundle/web-codex/cordis.patch.yml')
    const optInRows = rows('packages/bundle/web-codex/cordis.patch.yml')
    const composed = composeEntries([basePatches, webPatches, optInPatches])
    const required = [
      '@deepseek-ai/dsh-external-session',
      '@deepseek-ai/dsh-external-permission',
      '@deepseek-ai/dsh-external-session-codex',
      '@deepseek-ai/dsh-external-session-bridge',
      '@deepseek-ai/dsh-mcp-gateway',
    ]
    for (const name of required) {
      expect(optInRows.filter(row => row.name === name)).toHaveLength(1)
      expect(composed.filter(row => row.name === name)).toHaveLength(1)
      expect(patch.match(new RegExp(`name: ['"]${name.replaceAll('/', '\\/')}['"]`, 'g'))).toHaveLength(1)
    }
    expect(patch).not.toMatch(/(?:API_KEY|TOKEN|PASSWORD|SECRET)/u)

    const manifest = JSON.parse(readFileSync(resolve(root, 'packages/bundle/web-codex/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    for (const row of optInRows) {
      if (row.name === undefined) continue
      expect(manifest.dependencies).toHaveProperty(row.name)
    }
    expect(optInRows.find(row => row.name === '@deepseek-ai/dsh-external-session-codex')?.config).toMatchObject({
      args: ['app-server', '--stdio'],
      allowedTools: [],
      disposeGraceMs: 3000,
    })
    expect(optInRows.find(row => row.name === '@deepseek-ai/dsh-mcp-gateway')?.config).toMatchObject({
      allowlist: [],
      maxRequestBytes: 65536,
      maxResponseBytes: 65536,
      executionTimeoutMs: 60000,
    })
  })
})
