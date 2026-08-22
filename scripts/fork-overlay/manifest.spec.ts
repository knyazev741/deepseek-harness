import { describe, expect, it } from 'vitest'
import { parseOverlayManifest } from './manifest.ts'

const upstreamCommit = 'a'.repeat(40)

const validYaml = `
schemaVersion: 1
upstreamCommit: ${upstreamCommit}
entries:
  - id: fork-package
    kind: fork-owned
    paths:
      - path: packages/fork/feature/
        coverage: tree
    owner: packages/fork/feature
    agentNote: .agents/notes/implemented/feature/fork-feature.md
    verify:
      - kind: script
        name: test:fork-feature
      - kind: vitest
        files:
          - packages/fork/feature/tests/feature.spec.ts
    retireWhen: upstream provides the feature package
    generatedBy: pnpm run generate:fork-feature
  - id: composition-bundle
    kind: composition
    paths:
      - path: packages/bundle/fork/index.ts
        coverage: exact
    owner: packages/bundle/fork
    agentNote: .agents/notes/implemented/architecture/fork-composition.md
    verify:
      - kind: script
        name: test:fork-composition
    retireWhen: upstream exposes the required bundle composition
  - id: extension-point
    kind: extension-patch
    paths:
      - path: packages/client/upstream.ts
        coverage: exact
    owner: packages/fork/feature
    agentNote: .agents/notes/implemented/architecture/fork-extension.md
    verify:
      - kind: vitest
        files:
          - packages/client/tests/upstream.spec.ts
    retireWhen: upstream adds the registration point
    budget:
      maxFiles: 2
      maxChangedLines: 40
  - id: product-behavior
    kind: product-patch
    paths:
      - path: packages/core/product/
        coverage: tree
    owner: packages/fork/feature
    agentNote: .agents/notes/implemented/architecture/fork-product-patch.md
    verify:
      - kind: script
        name: test:fork-product
    retireWhen: the behavior is upstreamed
    budget:
      maxFiles: 1
      maxChangedLines: 10
  - id: sync-workflow
    kind: workflow
    paths:
      - path: .github/workflows/sync.yml
        coverage: exact
    owner: .github/workflows/sync.yml
    agentNote: .agents/notes/implemented/process/fork-sync.md
    verify:
      - kind: script
        name: test:fork-sync
    retireWhen: upstream provides the sync workflow
`

function yamlWithPath(path: string): string {
  return `
schemaVersion: 1
upstreamCommit: ${upstreamCommit}
entries:
  - id: path-entry
    kind: fork-owned
    paths:
      - path: ${JSON.stringify(path)}
        coverage: ${path.endsWith('/') ? 'tree' : 'exact'}
    owner: packages/fork
    agentNote: .agents/notes/implemented/architecture/fork.md
    verify:
      - kind: script
        name: test:fork
    retireWhen: upstream adopts the feature
`
}

function yamlWithAgentNote(agentNote: string): string {
  return validYaml.replace(
    '    agentNote: .agents/notes/implemented/feature/fork-feature.md',
    `    agentNote: ${JSON.stringify(agentNote)}`,
  )
}

describe('parseOverlayManifest', () => {
  it('parses one entry of every class', () => {
    const manifest = parseOverlayManifest(validYaml, 'fixture.yaml')

    expect(manifest).toMatchObject({ schemaVersion: 1, upstreamCommit })
    expect(manifest.entries.map(entry => entry.kind)).toEqual([
      'fork-owned',
      'composition',
      'extension-patch',
      'product-patch',
      'workflow',
    ])
    expect(manifest.entries[0]).toMatchObject({
      id: 'fork-package',
      paths: [{ path: 'packages/fork/feature/', coverage: 'tree' }],
      generatedBy: 'pnpm run generate:fork-feature',
    })
    expect(manifest.entries[2]?.budget).toEqual({ maxFiles: 2, maxChangedLines: 40 })
    expect(manifest.entries[2]?.verify).toEqual([
      { kind: 'vitest', files: ['packages/client/tests/upstream.spec.ts'] },
    ])
  })

  it('rejects duplicate entry ids', () => {
    const yaml = validYaml.replace('  - id: composition-bundle', '  - id: fork-package')

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/duplicate entry id.*fork-package/i)
  })

  it('rejects an upstream commit that is not forty hexadecimal characters', () => {
    const yaml = validYaml.replace(upstreamCommit, 'not-a-commit')

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/upstreamCommit.*40 hexadecimal/i)
  })

  it('rejects an empty path list', () => {
    const yaml = validYaml.replace(
      '    paths:\n      - path: packages/fork/feature/\n        coverage: tree',
      '    paths: []',
    )

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/paths.*at least one/i)
  })

  it.each(['../escape', '/absolute', 'packages/*/wild', 'packages/x?[y]'])('rejects unsafe path %s', (path) => {
    expect(() => parseOverlayManifest(yamlWithPath(path), 'fixture.yaml')).toThrow(/repository-relative path/i)
  })

  it('requires tree paths to have a trailing slash', () => {
    const yaml = yamlWithPath('packages/fork')
      .replace('coverage: exact', 'coverage: tree')

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/tree path.*trailing slash/i)
  })

  it('requires exact paths to omit a trailing slash', () => {
    const yaml = yamlWithPath('packages/fork/')
      .replace('coverage: tree', 'coverage: exact')

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/exact path.*trailing slash/i)
  })

  it('rejects tree coverage for workflow entries', () => {
    const yaml = validYaml.replace(
      '      - path: .github/workflows/sync.yml\n        coverage: exact',
      '      - path: .github/workflows/\n        coverage: tree',
    )

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/workflow.*exact/i)
  })

  it('requires workflow paths to be exact files beneath .github/workflows/', () => {
    const yaml = validYaml.replace(
      '      - path: .github/workflows/sync.yml\n        coverage: exact',
      '      - path: .github/actions/sync.yml\n        coverage: exact',
    )

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml'))
      .toThrow(/workflow.*\.github\/workflows/i)
  })

  it.each([
    '/absolute.md',
    'C:/absolute.md',
    'notes\\agent.md',
    '../escape.md',
    '.agents/notes/*.md',
    '.agents/notes/',
    'notes\u0000agent.md',
  ])('rejects unsafe agentNote path %s', (agentNote) => {
    expect(() => parseOverlayManifest(yamlWithAgentNote(agentNote), 'fixture.yaml'))
      .toThrow(/agentNote.*repository-relative file path/i)
  })

  it('prefixes an unsafe agentNote error with its manifest source', () => {
    expect(() => parseOverlayManifest(yamlWithAgentNote('../escape.md'), 'fixture.yaml'))
      .toThrow(/^fixture\.yaml: .*agentNote.*repository-relative file path/i)
  })

  it('does not require an agentNote file to exist while parsing', () => {
    expect(() => parseOverlayManifest(yamlWithAgentNote('notes/not-yet-created.md'), 'fixture.yaml'))
      .not.toThrow()
  })

  it('requires budgets on patch entries', () => {
    const yaml = validYaml.replace(
      '    budget:\n      maxFiles: 2\n      maxChangedLines: 40\n',
      '',
    )

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/extension-patch.*budget/i)
  })

  it('rejects budgets on fork-owned entries', () => {
    const yaml = validYaml.replace(
      '    generatedBy: pnpm run generate:fork-feature\n',
      '    generatedBy: pnpm run generate:fork-feature\n    budget:\n      maxFiles: 1\n      maxChangedLines: 1\n',
    )

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/fork-owned.*budget/i)
  })

  it.each([
    ['root', 'unexpected: true'],
    ['entry', '    unexpected: true'],
    ['path', '        unexpected: true'],
    ['verification target', '        unexpected: true'],
    ['budget', '      unexpected: true'],
  ])('rejects an unknown %s key', (_label, line) => {
    const yaml = _label === 'root'
      ? `${validYaml}\nunexpected: true\n`
      : _label === 'entry'
        ? validYaml.replace('    owner: packages/fork/feature', `${line}\n    owner: packages/fork/feature`)
        : _label === 'path'
          ? validYaml.replace('        coverage: tree', `        coverage: tree\n${line}`)
          : _label === 'verification target'
            ? validYaml.replace('        name: test:fork-feature', `        name: test:fork-feature\n${line}`)
            : validYaml.replace('      maxChangedLines: 40', `      maxChangedLines: 40\n${line}`)

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/unknown key.*unexpected/i)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects non-positive safe-integer budget %s', (maxFiles) => {
    const yaml = validYaml.replace('      maxFiles: 2', `      maxFiles: ${maxFiles}`)

    expect(() => parseOverlayManifest(yaml, 'fixture.yaml')).toThrow(/maxFiles.*positive safe integer/i)
  })

  it('prefixes YAML and semantic errors with the manifest source name', () => {
    expect(() => parseOverlayManifest('schemaVersion: [', 'fixture.yaml')).toThrow(/^fixture\.yaml: /)
    expect(() => parseOverlayManifest(validYaml.replace('schemaVersion: 1', 'schemaVersion: 2'), 'fixture.yaml'))
      .toThrow(/^fixture\.yaml: /)
  })
})
