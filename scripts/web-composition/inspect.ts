/** Inspect built Web output and its served boot metadata without reading source manifests. */

import { globSync, readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { WebCompositionEvidence, WebCompositionProfile } from './types.ts'

/** Browser module id required before the Vite shell can create its module system. */
export const BOOTSTRAP_MODULE_ID = '@knyazevai/dsh-client-modules'

/** Theme package id expected in every assembled Web boot graph. */
export const THEME_PLUGIN_ID = '@knyazevai/dsh-client-ui-theme'

/** Upstream client ids whose absence would leave the assembled shell incomplete. */
export const REQUIRED_UPSTREAM_PLUGIN_IDS: readonly string[] = [
  BOOTSTRAP_MODULE_ID,
  '@knyazevai/dsh-client-runtime',
  '@knyazevai/dsh-client-ui-conversation',
  THEME_PLUGIN_ID,
  '@knyazevai/dsh-client-ui-workspace',
]

/** Fork browser package mounted by the opt-in fork Web composition. */
export const FORK_WORKSPACE_OVERLAY_ID = '@knyazevai/dsh-fork-ui-workspace-overlay'

interface BootEntry {
  readonly id: string
}

interface BootGraph {
  readonly entries: readonly BootEntry[]
}

/** Normalize a filesystem glob path for deterministic evidence across hosts. */
function normalizePath(path: string): string {
  return path.split(sep).join('/')
}

/** Throw an artifact-specific error with the inspected output root included. */
function artifactError(root: string, message: string): never {
  throw new Error(`web composition (${root}): ${message}`)
}

/** Return a quoted HTML attribute value, or undefined when the attribute is absent. */
function attributeValue(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'iu').exec(attributes)?.[2]
}

/** Find script blocks in an HTML artifact, retaining attributes and body text. */
function scriptBlocks(html: string): readonly { attributes: string; body: string }[] {
  const blocks: { attributes: string; body: string }[] = []
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu
  for (const match of html.matchAll(pattern)) {
    blocks.push({ attributes: match[1] ?? '', body: match[2] ?? '' })
  }
  return blocks
}

/** Return the package id represented by a `/plugins/<id>/client.js` URL. */
function pluginIdFromUrl(url: string): string | undefined {
  const queryless = url.split(/[?#]/u, 1)[0] ?? ''
  const marker = '/plugins/'
  const markerAt = queryless.indexOf(marker)
  if (markerAt === -1 || !queryless.endsWith('/client.js')) return undefined
  const encoded = queryless.slice(markerAt + marker.length, -'/client.js'.length)
  if (encoded === '') return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

/** Parse the JSON value assigned to the Host-injected boot global. */
function parseBootGraph(html: string, root: string): BootGraph {
  for (const block of scriptBlocks(html)) {
    if (!/globalThis\s*\[\s*["']__DSH_BOOT__["']\s*\]/u.test(block.body)) continue
    const equalsAt = block.body.indexOf('=')
    if (equalsAt === -1) artifactError(root, 'boot metadata assignment is malformed')
    let serialized = block.body.slice(equalsAt + 1).trim()
    if (serialized.endsWith(';')) serialized = serialized.slice(0, -1).trimEnd()
    let value: unknown
    try {
      value = JSON.parse(serialized)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      artifactError(root, `boot metadata is invalid JSON: ${detail}`)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      artifactError(root, 'boot metadata must be an object')
    }
    const entries = (value as { entries?: unknown }).entries
    if (!Array.isArray(entries)) artifactError(root, 'boot metadata entries must be an array')
    return {
      entries: entries.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          artifactError(root, `boot metadata entry ${String(index + 1)} is not an object`)
        }
        const id = (entry as { id?: unknown }).id
        if (typeof id !== 'string' || id === '') {
          artifactError(root, `boot metadata entry ${String(index + 1)} has no string id`)
        }
        return { id }
      }),
    }
  }
  artifactError(root, 'boot metadata global __DSH_BOOT__ is missing')
}

/** True for an id owned by the fork overlay rather than upstream. */
function isForkPluginId(id: string): boolean {
  return /(?:^|[-/@])fork(?:-|$)/iu.test(id)
}

/** Validate one graph against the selected profile and return stable id evidence. */
function validateGraph(graph: BootGraph, root: string, profile: WebCompositionProfile): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of graph.entries) {
    if (seen.has(entry.id)) artifactError(root, `duplicate plugin id ${JSON.stringify(entry.id)}`)
    seen.add(entry.id)
    ids.push(entry.id)
  }

  const missing = REQUIRED_UPSTREAM_PLUGIN_IDS.filter(id => !seen.has(id))
  if (missing.length > 0) {
    artifactError(root, `upstream plugin id(s) missing: ${missing.join(', ')}`)
  }

  const forkIds = ids.filter(isForkPluginId)
  if (profile === 'web' && forkIds.length > 0) {
    artifactError(root, `fork plugin id(s) present in upstream profile: ${forkIds.join(', ')}`)
  }
  if (profile === 'fork-web' && !seen.has(FORK_WORKSPACE_OVERLAY_ID)) {
    artifactError(root, `fork workspace overlay ${JSON.stringify(FORK_WORKSPACE_OVERLAY_ID)} is missing`)
  }
  return ids.sort((left, right) => left.localeCompare(right))
}

/**
 * Inspect a built frontend directory and its Host-rendered `index.html`.
 *
 * This is intentionally an artifact-plane check: CSS is discovered from emitted
 * files, the bootstrap is read from rendered script tags, and plugin ids come
 * only from the injected `__DSH_BOOT__` graph. Source manifests and source text
 * are not accepted as evidence.
 *
 * @param outputRoot - directory containing the clean built frontend output.
 * @param profile - composition selected for the output.
 * @returns validated artifact evidence with deterministic path and id ordering.
 */
export function inspectWebComposition(
  outputRoot: string,
  profile: WebCompositionProfile,
): WebCompositionEvidence {
  const root = resolve(outputRoot)
  const cssFiles = globSync('**/*.css', { cwd: root })
    .map(normalizePath)
    .filter(path => statSync(resolve(root, path)).isFile())
    .sort()
  if (cssFiles.length === 0) artifactError(root, 'no CSS assets were emitted')

  const indexPath = resolve(root, 'index.html')
  let html: string
  try {
    html = readFileSync(indexPath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    artifactError(root, `built index.html is unreadable: ${detail}`)
  }

  const bootstrapModules = scriptBlocks(html)
    .map(block => attributeValue(block.attributes, 'src'))
    .filter((src): src is string => src !== undefined)
    .map(pluginIdFromUrl)
    .filter((id): id is string => id !== undefined)
  if (!bootstrapModules.includes(BOOTSTRAP_MODULE_ID)) {
    artifactError(root, `bootstrap module ${JSON.stringify(BOOTSTRAP_MODULE_ID)} is missing from index.html`)
  }

  const pluginIds = validateGraph(parseBootGraph(html, root), root, profile)
  return {
    profile,
    cssFiles,
    bootstrapModule: BOOTSTRAP_MODULE_ID,
    pluginIds,
    themePluginId: THEME_PLUGIN_ID,
  }
}
