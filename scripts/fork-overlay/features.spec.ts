import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSON_SCHEMA, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const inventoryPath = resolve(repositoryRoot, '.fork/features.yaml')

const REQUIRED_FEATURES = [
  'compaction-bounded-input',
  'stream-first-chunk-idle-timeout',
  'workspace-copy-session-id',
  'workspace-mark-unread',
  'workspace-background-filter',
  'workspace-session-pin',
  'github-actions-session-source',
  'subagent-recursive-fork',
  'subagent-per-call-model-routing',
  'external-session-generic',
  'external-session-codex',
] as const

const ALLOWED_DISPOSITIONS = ['preserved', 'adapted', 'upstreamed', 'retired', 'deferred'] as const
const ALLOWED_SOURCE_COMMITS = [
  '078d3db591',
  'eb25108045',
  '842170d111',
  'cc565b1065',
  '44c01788c1',
  '3a1558b55e..72ff0d079c',
  '3eb7008e09',
] as const
const ROOT_KEYS = ['schemaVersion', 'features'] as const
const RECORD_KEYS = ['id', 'sourceCommits', 'requiredBehavior', 'evidence', 'disposition', 'replacement'] as const
const TEST_FILE_SUFFIXES = ['.spec.ts', '.spec.tsx', '.e2e.ts', '.test.mjs'] as const

type FeatureDisposition = (typeof ALLOWED_DISPOSITIONS)[number]
type AllowedSourceCommit = (typeof ALLOWED_SOURCE_COMMITS)[number]

type FeatureRecord = {
  readonly id: string
  readonly sourceCommits: readonly string[]
  readonly requiredBehavior: string
  readonly evidence: readonly string[]
  readonly disposition: FeatureDisposition
  readonly replacement?: string
}

type FeatureInventory = {
  readonly schemaVersion: 1
  readonly features: readonly FeatureRecord[]
}

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

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function isAllowedSourceCommit(value: string): value is AllowedSourceCommit {
  return (ALLOWED_SOURCE_COMMITS as readonly string[]).includes(value)
}

function repositoryRelativeTestFile(value: unknown, label: string): string {
  const path = nonEmptyString(value, label)
  const hasGlobSyntax = ['*', '?', '[', ']', '{', '}'].some(character => path.includes(character))
  const hasAbsolutePrefix = path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)
  const hasUriScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
  const hasTraversal = path.split('/').some(segment => segment === '..')
  const hasSupportedSuffix = TEST_FILE_SUFFIXES.some(suffix => path.endsWith(suffix))
  if (hasGlobSyntax || hasAbsolutePrefix || hasUriScheme || path.includes('\\') || path.includes('\u0000')
    || hasTraversal || !hasSupportedSuffix) {
    throw new Error(`${label} must be an exact repository-relative test file without traversal or glob syntax`)
  }
  return path
}

function parseFeatureRecord(value: unknown, index: number): FeatureRecord {
  const label = `features[${index}]`
  const feature = record(value, label)
  rejectUnknownKeys(feature, RECORD_KEYS, label)
  const id = nonEmptyString(required(feature, 'id', label), `${label}.id`)
  const sourceCommitsValue = required(feature, 'sourceCommits', label)
  if (!Array.isArray(sourceCommitsValue) || sourceCommitsValue.length === 0) {
    throw new Error(`${label}.sourceCommits must contain at least one commit`)
  }
  const sourceCommits = sourceCommitsValue.map((commit, commitIndex) => {
    const sourceCommit = nonEmptyString(commit, `${label}.sourceCommits[${commitIndex}]`)
    if (!isAllowedSourceCommit(sourceCommit)) {
      throw new Error(`${label}.sourceCommits[${commitIndex}] must be one of the allowed source commit labels`)
    }
    return sourceCommit
  })
  const requiredBehavior = nonEmptyString(
    required(feature, 'requiredBehavior', label),
    `${label}.requiredBehavior`,
  )
  const evidenceValue = required(feature, 'evidence', label)
  if (!Array.isArray(evidenceValue) || evidenceValue.length === 0) {
    throw new Error(`${label}.evidence must contain at least one test file`)
  }
  const evidence = evidenceValue.map((path, pathIndex) => (
    repositoryRelativeTestFile(path, `${label}.evidence[${pathIndex}]`)
  ))
  const dispositionValue = nonEmptyString(required(feature, 'disposition', label), `${label}.disposition`)
  if (!(ALLOWED_DISPOSITIONS as readonly string[]).includes(dispositionValue)) {
    throw new Error(`${label}.disposition must be one of ${ALLOWED_DISPOSITIONS.join(', ')}`)
  }
  const disposition = dispositionValue as FeatureDisposition
  const replacement = has(feature, 'replacement')
    ? nonEmptyString(feature.replacement, `${label}.replacement`)
    : undefined
  if ((disposition === 'retired' || disposition === 'deferred') && replacement === undefined) {
    throw new Error(`${label}.replacement is required for ${disposition} features`)
  }
  return {
    id,
    sourceCommits,
    requiredBehavior,
    evidence,
    disposition,
    ...(replacement === undefined ? {} : { replacement }),
  }
}

function parseFeatureInventory(text: string): FeatureInventory {
  const root = record(load(text, { schema: JSON_SCHEMA }), 'features inventory')
  rejectUnknownKeys(root, ROOT_KEYS, 'features inventory')
  if (root.schemaVersion !== 1) throw new Error('features inventory.schemaVersion must be 1')
  const featuresValue = required(root, 'features', 'features inventory')
  if (!Array.isArray(featuresValue)) throw new Error('features inventory.features must be an array')
  const features = featuresValue.map((feature, index) => parseFeatureRecord(feature, index))
  const ids = new Set<string>()
  for (const feature of features) {
    if (ids.has(feature.id)) throw new Error(`duplicate feature id ${feature.id}`)
    ids.add(feature.id)
  }
  return { schemaVersion: 1, features }
}

function validFeatureYaml(overrides = ''): string {
  return `schemaVersion: 1
features:
  - id: fixture
    sourceCommits:
      - "3eb7008e09"
    requiredBehavior: A fixture behavior remains observable.
    evidence:
      - packages/fork/fixture/tests/fixture.spec.ts
    disposition: adapted
    replacement: Fork-owned fixture replacement.
${overrides}`
}

describe('fork feature inventory schema', () => {
  it('loads the inventory with the exact closed feature id list and reviewed migration dispositions', () => {
    const inventory = parseFeatureInventory(readFileSync(inventoryPath, 'utf8'))

    expect(inventory.features.map(feature => feature.id)).toEqual(REQUIRED_FEATURES)
    expect(inventory.features.flatMap(feature => feature.sourceCommits).every(commit => (
      (ALLOWED_SOURCE_COMMITS as readonly string[]).includes(commit)
    ))).toBe(true)
    expect(inventory.features.filter(feature => !['workspace-background-filter', 'external-session-codex'].includes(feature.id)).every(feature => feature.disposition === 'adapted')).toBe(true)
    expect(inventory.features.at(-1)).toMatchObject({
      id: 'external-session-codex',
      disposition: 'deferred',
      replacement: 'Optional upstream Codex providers remain opt-in; the fork bundles do not enable them.',
    })
  })

  it('rejects unknown root and record keys', () => {
    expect(() => parseFeatureInventory(`${validFeatureYaml()}unexpected: true\n`))
      .toThrow(/unknown key.*unexpected/i)
    expect(() => parseFeatureInventory(validFeatureYaml('    unexpected: true\n')))
      .toThrow(/unknown key.*unexpected/i)
  })

  it('rejects duplicate feature ids', () => {
    const duplicate = `${validFeatureYaml()}  - id: fixture
    sourceCommits:
      - "3eb7008e09"
    requiredBehavior: A second fixture behavior remains observable.
    evidence:
      - packages/fork/fixture/tests/second.spec.ts
    disposition: adapted
    replacement: Another fork-owned fixture replacement.
`

    expect(() => parseFeatureInventory(duplicate)).toThrow(/duplicate feature id.*fixture/i)
  })

  it.each(['preserved', 'adapted', 'upstreamed', 'retired', 'deferred'] as const)(
    'accepts the allowed disposition %s',
    (disposition) => {
      const replacement = disposition === 'retired' || disposition === 'deferred'
        ? 'A replacement is recorded.'
        : 'A replacement is optional for this disposition.'
      const yaml = validFeatureYaml()
        .replace('    disposition: adapted', `    disposition: ${disposition}`)
        .replace('    replacement: Fork-owned fixture replacement.', `    replacement: ${replacement}`)

      expect(() => parseFeatureInventory(yaml)).not.toThrow()
    },
  )

  it('rejects an unsupported disposition', () => {
    expect(() => parseFeatureInventory(validFeatureYaml().replace('    disposition: adapted', '    disposition: copied')))
      .toThrow(/disposition.*one of/i)
  })

  it('rejects source commit labels outside the closed set from the brief', () => {
    expect(() => parseFeatureInventory(validFeatureYaml().replace('3eb7008e09', 'not-an-allowed-source')))
      .toThrow(/sourceCommits.*allowed/i)
  })

  it.each(['', '   '])('rejects empty observable behavior text %j', (requiredBehavior) => {
    expect(() => parseFeatureInventory(validFeatureYaml().replace(
      '    requiredBehavior: A fixture behavior remains observable.',
      `    requiredBehavior: ${JSON.stringify(requiredBehavior)}`,
    ))).toThrow(/requiredBehavior.*non-empty/i)
  })

  it('rejects an empty source commit list and empty source commit values', () => {
    expect(() => parseFeatureInventory(validFeatureYaml().replace(
      '    sourceCommits:\n      - "3eb7008e09"',
      '    sourceCommits: []',
    ))).toThrow(/sourceCommits.*at least one/i)
    expect(() => parseFeatureInventory(validFeatureYaml().replace('      - "3eb7008e09"', '      - ""')))
      .toThrow(/sourceCommits.*non-empty/i)
  })

  it.each([
    '../escape.spec.ts',
    'packages/*/fixture.spec.ts',
    '/absolute/fixture.spec.ts',
    'C:/absolute/fixture.spec.ts',
    'https://host/fixture.spec.ts',
    'file:///tmp/fixture.spec.ts',
    'packages\\fixture.spec.ts',
    'packages/fixture/tests/fixture.txt',
    'packages/fixture/tests/',
  ])('rejects unsafe or non-test evidence path %s', (path) => {
    const yaml = validFeatureYaml().replace('packages/fork/fixture/tests/fixture.spec.ts', path)

    expect(() => parseFeatureInventory(yaml)).toThrow(/evidence.*exact repository-relative test file/i)
  })

  it('accepts a future exact evidence file without requiring it to exist', () => {
    const yaml = validFeatureYaml().replace(
      'packages/fork/fixture/tests/fixture.spec.ts',
      'packages/fork/not-yet-created/tests/future.spec.ts',
    )

    expect(() => parseFeatureInventory(yaml)).not.toThrow()
  })

  it('requires evidence and replacement values where the disposition needs them', () => {
    expect(() => parseFeatureInventory(validFeatureYaml().replace(
      '    evidence:\n      - packages/fork/fixture/tests/fixture.spec.ts',
      '    evidence: []',
    ))).toThrow(/evidence.*at least one/i)
    for (const disposition of ['retired', 'deferred'] as const) {
      const yaml = validFeatureYaml()
        .replace('    disposition: adapted', `    disposition: ${disposition}`)
        .replace('    replacement: Fork-owned fixture replacement.\n', '')
      expect(() => parseFeatureInventory(yaml)).toThrow(/replacement.*required/i)
    }
    const withoutReplacement = validFeatureYaml().replace('    replacement: Fork-owned fixture replacement.\n', '')
    expect(() => parseFeatureInventory(withoutReplacement)).not.toThrow()
  })
})
