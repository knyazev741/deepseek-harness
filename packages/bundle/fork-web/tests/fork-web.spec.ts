/**
 * Composition contract for the opt-in fork Web bundle. These tests parse the
 * shipped YAML layers and exercise the same entry patch implementation used by
 * profile boot, so row ownership and duplicate prevention stay observable.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

interface Manifest {
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

interface Patch {
  insert?: Row[]
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
  [key: string]: unknown
}

interface Row extends EntryOptions {
  id: string
  name: string
  config?: Record<string, unknown>
}

const root = fileURLToPath(new URL('..', import.meta.url))

function readPatch(path: string): Patch[] {
  const parsed = yaml.load(readFileSync(resolve(root, path), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('fork-web patch must be an entry list')
  return parsed as Patch[]
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
}

function flattenInsertRows(patches: Patch[]): Row[] {
  return patches.flatMap(patch => patch.insert ?? [])
}

function compose(bundlePaths: readonly string[]): Row[] {
  const layers = bundlePaths.map(path => readPatch(path))
  return applyEntryPatches([], layers.flat(), () => {})
}

describe('dsh-fork-web bundle', () => {
  it('declares the patch file and its upstream bundle plus UI dependencies', () => {
    const manifest = readManifest()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@knyazevai/dsh-base': 'workspace:^',
      '@knyazevai/dsh-web-app': 'workspace:^',
      '@knyazevai/dsh-fork-base': 'workspace:^',
      '@knyazevai/dsh-fork-ui-workspace-overlay': 'workspace:^',
    })
  })

  it('uses insert only for the one browser overlay row', () => {
    const patches = readPatch('./cordis.patch.yml')
    expect(patches).toHaveLength(2)
    expect(patches[1]).toMatchObject({
      id: 'subagent-model-selection-settings',
      config: { enabled: true, allowedModels: [
        { provider: 'knyazev-ai', model: 'deepseek-v4-flash' },
        { provider: 'knyazev-ai', model: 'glm-5.3-flash' },
        { provider: 'knyazev-ai', model: 'kimi-2.6' },
        { provider: 'knyazev-ai', model: 'minimax-2.7' },
      ] },
    })
    expect(Object.keys(patches[0] ?? {})).toEqual(['insert'])
    const rows = flattenInsertRows(patches)
    expect(rows.map(row => row.id)).toEqual(['ui-workspace-overlay'])
    expect(rows.map(row => row.name)).toEqual(['@knyazevai/dsh-fork-ui-workspace-overlay'])
  })

  it('leaves the default Web profile free of fork rows', () => {
    const rows = compose(['../base/cordis.patch.yml', '../web-app/cordis.patch.yml'])
    expect(rows.filter(row => row.id.startsWith('fork-'))).toEqual([])
    expect(rows.filter(row => row.name?.includes('/dsh-fork-'))).toEqual([])
  })

  it('adds each fork row exactly once and preserves upstream UI identities', () => {
    const rows = compose([
      '../base/cordis.patch.yml',
      '../web-app/cordis.patch.yml',
      '../fork-base/cordis.patch.yml',
      './cordis.patch.yml',
    ])
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
    expect(counts.get('fork-session-source')).toBe(1)
    expect(counts.get('fork-workspace-session-state')).toBe(1)
    expect(counts.get('fork-llm-first-chunk-timeout')).toBe(1)
    expect(counts.get('fork-llm-rate-limit-cooldown')).toBe(1)
    expect(counts.get('ui-workspace-overlay')).toBe(1)
    expect(rows.filter(row => row.id.startsWith('fork-')).map(row => row.id)).toEqual([
      'fork-session-source',
      'fork-workspace-session-state',
      'fork-llm-first-chunk-timeout',
      'fork-llm-rate-limit-cooldown',
    ])
    expect(Object.fromEntries(rows
      .filter(row => ['ui-theme', 'session-controller', 'ui-conversation', 'ui-workspace'].includes(row.id))
      .map(row => [row.id, row.name]))).toEqual({
      'session-controller': '@knyazevai/dsh-api-session-controller',
      'ui-conversation': '@knyazevai/dsh-client-ui-conversation',
      'ui-theme': '@knyazevai/dsh-client-ui-theme',
      'ui-workspace': '@knyazevai/dsh-client-ui-workspace',
    })
  })
})
