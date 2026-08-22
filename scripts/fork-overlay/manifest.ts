import { JSON_SCHEMA, load } from 'js-yaml'
import type {
  OverlayEntry,
  OverlayKind,
  OverlayManifest,
  OverlayPath,
  PatchBudget,
  VerificationTarget,
} from './types.ts'

const manifestKeys = ['schemaVersion', 'upstreamCommit', 'entries'] as const
const entryKeys = ['id', 'kind', 'paths', 'owner', 'agentNote', 'verify', 'retireWhen', 'budget', 'generatedBy'] as const
const pathKeys = ['path', 'coverage'] as const
const budgetKeys = ['maxFiles', 'maxChangedLines'] as const
const scriptTargetKeys = ['kind', 'name'] as const
const vitestTargetKeys = ['kind', 'files'] as const

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function has(recordValue: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(recordValue, key)
}

function required(recordValue: RecordValue, key: string, label: string): unknown {
  if (!has(recordValue, key)) throw new Error(`${label} is missing required key ${key}`)
  return recordValue[key]
}

function rejectUnknownKeys(recordValue: RecordValue, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(recordValue)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unknown key ${key}`)
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function repositoryRelativePath(value: unknown, label: string): string {
  const path = stringValue(value, label)
  const hasGlobSyntax = ['*', '?', '[', ']', '{', '}'].some(character => path.includes(character))
  const hasAbsolutePrefix = path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)
  const hasTraversal = path.split('/').some(segment => segment === '..')
  if (hasGlobSyntax || hasAbsolutePrefix || path.includes('\\') || path.includes('\u0000') || hasTraversal) {
    throw new Error(`${label} must be a repository-relative path without traversal or glob syntax`)
  }
  return path
}

function repositoryRelativeFilePath(value: unknown, label: string): string {
  const path = stringValue(value, label)
  const hasGlobSyntax = ['*', '?', '[', ']', '{', '}'].some(character => path.includes(character))
  const hasAbsolutePrefix = path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)
  const hasTraversal = path.split('/').some(segment => segment === '..')
  if (hasGlobSyntax || hasAbsolutePrefix || path.includes('\\') || path.includes('\u0000') || hasTraversal || path.endsWith('/')) {
    throw new Error(`${label} must be a repository-relative file path without traversal, glob syntax, backslashes, NUL, or a trailing slash`)
  }
  return path
}

function overlayKind(value: unknown, label: string): OverlayKind {
  const kind = stringValue(value, label)
  switch (kind) {
    case 'fork-owned':
    case 'composition':
    case 'extension-patch':
    case 'product-patch':
    case 'workflow':
      return kind
    default:
      throw new Error(`${label} has unsupported overlay kind ${kind}`)
  }
}

function parsePath(value: unknown, label: string): OverlayPath {
  const pathValue = record(value, label)
  rejectUnknownKeys(pathValue, pathKeys, label)
  const path = repositoryRelativePath(required(pathValue, 'path', label), `${label}.path`)
  const coverage = stringValue(required(pathValue, 'coverage', label), `${label}.coverage`)
  if (coverage !== 'exact' && coverage !== 'tree') {
    throw new Error(`${label}.coverage must be exact or tree`)
  }
  if (coverage === 'tree' && !path.endsWith('/')) {
    throw new Error(`${label} tree path must have a trailing slash`)
  }
  if (coverage === 'exact' && path.endsWith('/')) {
    throw new Error(`${label} exact path must not have a trailing slash`)
  }
  return { path, coverage }
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function parseBudget(value: unknown, label: string): PatchBudget {
  const budget = record(value, label)
  rejectUnknownKeys(budget, budgetKeys, label)
  return {
    maxFiles: positiveSafeInteger(required(budget, 'maxFiles', label), `${label}.maxFiles`),
    maxChangedLines: positiveSafeInteger(required(budget, 'maxChangedLines', label), `${label}.maxChangedLines`),
  }
}

function parseVerificationTarget(value: unknown, label: string): VerificationTarget {
  const target = record(value, label)
  const kind = stringValue(required(target, 'kind', label), `${label}.kind`)
  if (kind === 'script') {
    rejectUnknownKeys(target, scriptTargetKeys, label)
    return { kind, name: stringValue(required(target, 'name', label), `${label}.name`) }
  }
  if (kind === 'vitest') {
    rejectUnknownKeys(target, vitestTargetKeys, label)
    const filesValue = required(target, 'files', label)
    if (!Array.isArray(filesValue) || filesValue.length === 0) {
      throw new Error(`${label}.files must contain at least one path`)
    }
    return {
      kind,
      files: filesValue.map((file, index) => repositoryRelativePath(file, `${label}.files[${index}]`)),
    }
  }
  throw new Error(`${label}.kind must be script or vitest`)
}

function parseEntry(value: unknown, index: number): OverlayEntry {
  const label = `entries[${index}]`
  const entry = record(value, label)
  rejectUnknownKeys(entry, entryKeys, label)
  const id = stringValue(required(entry, 'id', label), `${label}.id`)
  const kind = overlayKind(required(entry, 'kind', label), `${label}.kind`)
  const pathsValue = required(entry, 'paths', label)
  if (!Array.isArray(pathsValue) || pathsValue.length === 0) {
    throw new Error(`${label}.paths must contain at least one path`)
  }
  const paths = pathsValue.map((path, pathIndex) => parsePath(path, `${label}.paths[${pathIndex}]`))
  if (kind === 'workflow' && paths.some(path => path.coverage !== 'exact' || !path.path.startsWith('.github/workflows/'))) {
    throw new Error(`${label} workflow paths must be exact files beneath .github/workflows/`)
  }
  const owner = stringValue(required(entry, 'owner', label), `${label}.owner`)
  const agentNote = repositoryRelativeFilePath(required(entry, 'agentNote', label), `${label}.agentNote`)
  const verifyValue = required(entry, 'verify', label)
  if (!Array.isArray(verifyValue) || verifyValue.length === 0) {
    throw new Error(`${label}.verify must contain at least one verification target`)
  }
  const verify = verifyValue.map((target, targetIndex) => parseVerificationTarget(target, `${label}.verify[${targetIndex}]`))
  const retireWhen = stringValue(required(entry, 'retireWhen', label), `${label}.retireWhen`)
  const budget = has(entry, 'budget') ? parseBudget(entry.budget, `${label}.budget`) : undefined
  const isPatch = kind === 'extension-patch' || kind === 'product-patch'
  if (isPatch && budget === undefined) {
    throw new Error(`${label} ${kind} requires a budget`)
  }
  if (!isPatch && budget !== undefined) {
    throw new Error(`${label} ${kind} must not define a budget`)
  }
  const generatedBy = has(entry, 'generatedBy')
    ? stringValue(entry.generatedBy, `${label}.generatedBy`)
    : undefined
  return {
    id,
    kind,
    paths,
    owner,
    agentNote,
    verify,
    retireWhen,
    ...(budget === undefined ? {} : { budget }),
    ...(generatedBy === undefined ? {} : { generatedBy }),
  }
}

function parseManifest(value: unknown): OverlayManifest {
  const root = record(value, 'manifest')
  rejectUnknownKeys(root, manifestKeys, 'manifest')
  const schemaVersion = required(root, 'schemaVersion', 'manifest')
  if (schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1')
  const upstreamCommit = stringValue(required(root, 'upstreamCommit', 'manifest'), 'manifest.upstreamCommit')
  if (!/^[0-9a-fA-F]{40}$/.test(upstreamCommit)) {
    throw new Error('manifest.upstreamCommit must be a 40 hexadecimal character commit')
  }
  const entriesValue = required(root, 'entries', 'manifest')
  if (!Array.isArray(entriesValue)) throw new Error('manifest.entries must be an array')
  const entries = entriesValue.map((entry, index) => parseEntry(entry, index))
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`duplicate entry id ${entry.id}`)
    ids.add(entry.id)
  }
  return { schemaVersion: 1, upstreamCommit, entries }
}

/**
 * Parse and semantically validate an overlay manifest.
 * @param text YAML manifest text.
 * @param source Manifest source name used to prefix parse and validation errors.
 * @returns The validated overlay manifest.
 */
export function parseOverlayManifest(text: string, source: string): OverlayManifest {
  try {
    return parseManifest(load(text, { schema: JSON_SCHEMA }))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${source}: ${message}`)
  }
}
