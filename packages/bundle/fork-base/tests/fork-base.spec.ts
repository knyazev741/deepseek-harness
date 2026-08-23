/**
 * The fork-base bundle is a fork-owned overlay over dsh-base. These tests read
 * the same YAML dialect used by the Loader and compose the two patch lists
 * through the include's patch implementation.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

interface Manifest {
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

interface Row extends EntryOptions {
  id: string
  name: string
  config?: Record<string, unknown>
}

interface Patch {
  insert?: Row[]
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
  [key: string]: unknown
}

const root = fileURLToPath(new URL('..', import.meta.url))

function readManifest(): Manifest {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
}

function readPatch(path: string): Patch[] {
  const parsed = yaml.load(readFileSync(resolve(root, path), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('fork-base patch must be an entry list')
  return parsed as Patch[]
}

function flattenInsertRows(patches: Patch[]): Row[] {
  return patches.flatMap(patch => patch.insert ?? [])
}

describe('dsh-fork-base bundle', () => {
  it('declares the patch file and exactly the three accepted fork packages', () => {
    const manifest = readManifest()
    expect(manifest.private).toBe(true)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-fork-session-source': 'workspace:^',
      '@deepseek-ai/dsh-fork-workspace-session-state': 'workspace:^',
      '@deepseek-ai/dsh-fork-llm-first-chunk-timeout': 'workspace:^',
    })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-fork-llm-first-chunk-timeout',
      '@deepseek-ai/dsh-fork-session-source',
      '@deepseek-ai/dsh-fork-workspace-session-state',
    ])
  })

  it('inserts ordered, unique, Codex-free fork rows without secret literals', () => {
    const patches = readPatch('./cordis.patch.yml')
    expect(patches).toHaveLength(3)
    expect(Object.keys(patches[0] ?? {})).toEqual(['insert'])
    expect(patches.slice(1).map(patch => patch.id)).toEqual([
      'llm-pi-ai',
      'agent-default-model',
    ])

    const rows = flattenInsertRows(patches)
    expect(rows.map(row => row.id)).toEqual([
      'fork-session-source',
      'fork-workspace-session-state',
      'fork-llm-first-chunk-timeout',
    ])
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
    expect(rows.map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-fork-session-source',
      '@deepseek-ai/dsh-fork-workspace-session-state',
      '@deepseek-ai/dsh-fork-llm-first-chunk-timeout',
    ])
    expect(rows.find(row => row.id === 'fork-llm-first-chunk-timeout')?.config)
      .toEqual({ firstChunkIdleTimeoutMs: 120000 })
    expect(rows.some(row => row.name?.toLowerCase().includes('codex'))).toBe(false)
    expect(rows.some(row => row.name === '@deepseek-ai/dsh-fork-external-session')).toBe(false)
    const serialized = JSON.stringify(patches)
    expect(serialized).not.toMatch(/"apiKey"\s*:/)
    expect(serialized).not.toMatch(/(?:sk-|AIza|gh[pousr]_|xox[baprs]-)\w{8,}/i)
  })

  it('composes portable defaults over upstream rows and accepts a later replacement layer', () => {
    const base = readPatch(resolve(root, '../base/cordis.patch.yml'))
    const overlay = readPatch('./cordis.patch.yml')
    const upstreamRows = flattenInsertRows(base)
    const rows = applyEntryPatches(upstreamRows, overlay, () => {})
    const ids = rows.map(row => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(rows.some(row => row.name?.toLowerCase().includes('codex'))).toBe(false)
    expect(rows.some(row => row.name === '@deepseek-ai/dsh-fork-external-session')).toBe(false)
    const llm = rows.find(row => row.id === 'llm-pi-ai')
    const defaultModel = rows.find(row => row.id === 'agent-default-model')
    expect(llm?.config).toEqual({
      providers: {
        'knyazev-ai': {
          apiKeyEnv: 'KNYAZEV_AI_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://knyazevai.work/v1',
          streamIdleTimeoutMs: 900000,
          timeoutMs: 1800000,
          retryPolicy: {
            mode: 'normal',
            maxRetries: 20,
            retryableCodes: [
              'RATE_LIMIT',
              'QUOTA',
              'SERVER',
              'TIMEOUT',
              'FIRST_CHUNK_TIMEOUT',
              'TRANSPORT',
              'STREAM_CLOSED',
              'EMPTY_RESPONSE',
            ],
          },
          compat: {
            thinkingFormat: 'qwen',
            supportsReasoningEffort: false,
          },
          reasoning: 'high',
          models: [
            {
              id: 'deepseek-v4-flash',
              name: 'DeepSeek V4 Flash',
              contextWindow: 400000,
              maxTokens: 128000,
              reasoningEfforts: {
                off: null,
                high: 'high',
                max: 'max',
              },
            },
            {
              id: 'kimi-2.6',
              name: 'Kimi 2.6',
              contextWindow: 262144,
              maxTokens: 40000,
              reasoningEfforts: {
                off: null,
                high: 'high',
                max: 'max',
              },
            },
            {
              id: 'minimax-2.7',
              name: 'MiniMax 2.7',
              contextWindow: 204800,
            },
          ],
        },
      },
    })
    expect(defaultModel?.config).toEqual({
      provider: 'knyazev-ai',
      model: 'deepseek-v4-flash',
    })
    expect(llm?.config).not.toHaveProperty('providers.knyazev-ai.apiKey')
    expect(defaultModel?.config).not.toHaveProperty('reasoningEffort')

    const overridden = new Set(['llm-pi-ai', 'agent-default-model'])
    for (const upstreamRow of upstreamRows) {
      if (overridden.has(upstreamRow.id)) continue
      expect(rows.find(row => row.id === upstreamRow.id)).toEqual(upstreamRow)
    }
    for (const id of ['llm', 'session', 'session-projection', 'settings']) {
      expect(ids.indexOf(id)).toBeGreaterThanOrEqual(0)
    }
    for (const id of ['fork-session-source', 'fork-workspace-session-state', 'fork-llm-first-chunk-timeout']) {
      expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf('settings'))
    }

    const later = applyEntryPatches(rows, [
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            'knyazev-ai': {
              apiKeyEnv: 'USER_API_KEY_REF',
              baseURL: 'https://user.example/v1',
            },
          },
        },
      },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-reasoner' } },
      { id: 'fork-session-source', disabled: true },
      { id: 'fork-workspace-session-state', disabled: true },
      { id: 'fork-llm-first-chunk-timeout', config: { firstChunkIdleTimeoutMs: 60000 } },
    ], () => {})
    expect(later.find(row => row.id === 'llm-pi-ai')?.config).toEqual({
      providers: {
        'knyazev-ai': {
          apiKeyEnv: 'USER_API_KEY_REF',
          baseURL: 'https://user.example/v1',
        },
      },
    })
    expect(later.find(row => row.id === 'agent-default-model')?.config).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
    })
    expect(later.find(row => row.id === 'fork-session-source')?.disabled).toBe(true)
    expect(later.find(row => row.id === 'fork-workspace-session-state')?.disabled).toBe(true)
    expect(later.find(row => row.id === 'fork-llm-first-chunk-timeout')?.config)
      .toEqual({ firstChunkIdleTimeoutMs: 60000 })
    expect(later.find(row => row.id === 'agent')?.name).toBe('@deepseek-ai/dsh-agent')
  })

  it('keeps the upstream base patch bytes unchanged', () => {
    const basePath = resolve(root, '../base/cordis.patch.yml')
    const digest = execFileSync('git', ['hash-object', basePath], { encoding: 'utf8' }).trim()
    expect(digest).toBe('e9567d9206e5b8c64b40cf76b88619f383f2269e')
  })
})
