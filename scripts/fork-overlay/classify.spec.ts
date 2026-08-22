import { describe, expect, it } from 'vitest'
import { classifyOverlay } from './classify.ts'
import type { OverlayEntry, OverlayKind, OverlayManifest, PatchBudget } from './types.ts'

type TestDiff = {
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
  readonly path: string
  readonly oldPath?: string
  readonly added: number
  readonly removed: number
  readonly binary: boolean
}

const upstreamCommit = 'a'.repeat(40)

function makeEntry(
  id: string,
  kind: OverlayKind,
  path: string,
  coverage: 'exact' | 'tree',
  budget?: PatchBudget,
): OverlayEntry {
  const base = {
    id,
    kind,
    paths: [{ path, coverage }],
    owner: `packages/fork/${id}`,
    agentNote: `.agents/notes/implemented/architecture/${id}.md`,
    verify: [{ kind: 'script' as const, name: `test:${id}` }],
    retireWhen: 'upstream provides the behavior',
  }
  return budget === undefined ? base : { ...base, budget }
}

function makeManifest(entries: readonly OverlayEntry[]): OverlayManifest {
  return { schemaVersion: 1, upstreamCommit, entries }
}

function fixture(options: {
  readonly entries?: readonly OverlayEntry[]
  readonly diffs?: readonly TestDiff[]
  readonly upstreamPaths?: ReadonlySet<string>
} = {}) {
  return classifyOverlay({
    manifest: makeManifest(options.entries ?? [makeEntry('default', 'fork-owned', 'packages/fork/x/', 'tree')]),
    diffs: options.diffs ?? [{
      status: 'M',
      path: 'packages/fork/x/src/index.ts',
      added: 1,
      removed: 0,
      binary: false,
    }],
    upstreamPaths: options.upstreamPaths ?? new Set<string>(),
  })
}

describe('classifyOverlay', () => {
  it('accepts an exact path and a deletion as one covered change', () => {
    const result = fixture({
      entries: [makeEntry('deleted-file', 'composition', 'packages/a/deleted.ts', 'exact')],
      diffs: [{ status: 'D', path: 'packages/a/deleted.ts', added: 0, removed: 4, binary: false }],
    })

    expect(result.diagnostics).toEqual([])
  })

  it('requires both sides of a rename to have one owner', () => {
    const result = fixture({
      entries: [makeEntry('renamed-file', 'composition', 'packages/a/new.ts', 'exact')],
      diffs: [{
        status: 'R',
        oldPath: 'packages/a/old.ts',
        path: 'packages/a/new.ts',
        added: 3,
        removed: 2,
        binary: false,
      }],
    })

    expect(result.diagnostics.map(item => item.code)).toEqual(['uncovered-path'])
    expect(result.diagnostics[0]?.path).toBe('packages/a/old.ts')
  })

  it('rejects overlapping exact and tree coverage', () => {
    const result = fixture({
      entries: [
        makeEntry('tree-owner', 'composition', 'packages/a/', 'tree'),
        makeEntry('exact-owner', 'composition', 'packages/a/file.ts', 'exact'),
      ],
      diffs: [{ status: 'M', path: 'packages/a/file.ts', added: 1, removed: 1, binary: false }],
    })

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'overlapping-coverage',
      path: 'packages/a/file.ts',
    }))
  })

  it('reports an entry whose declared paths have no changed file', () => {
    const result = fixture({
      entries: [
        makeEntry('active', 'composition', 'packages/a/changed.ts', 'exact'),
        makeEntry('stale', 'composition', 'packages/a/removed-from-diff.ts', 'exact'),
      ],
      diffs: [{ status: 'M', path: 'packages/a/changed.ts', added: 1, removed: 0, binary: false }],
    })

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'stale-entry',
      entryId: 'stale',
    }))
  })

  it('rejects a fork-owned path that appears upstream', () => {
    const result = fixture({
      entries: [makeEntry('fork-owned', 'fork-owned', 'packages/fork/x/', 'tree')],
      upstreamPaths: new Set(['packages/fork/x/src/index.ts']),
    })

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'fork-owned-collision',
      entryId: 'fork-owned',
      path: 'packages/fork/x/src/index.ts',
    }))
  })

  it('treats composition and workflow paths as fork-side ownership', () => {
    const result = classifyOverlay({
      manifest: makeManifest([
        makeEntry('composition', 'composition', 'packages/fork/assembly.ts', 'exact'),
        makeEntry('workflow', 'workflow', '.github/workflows/sync.yml', 'exact'),
      ]),
      diffs: [
        { status: 'M', path: 'packages/fork/assembly.ts', added: 1, removed: 0, binary: false },
        { status: 'M', path: '.github/workflows/sync.yml', added: 1, removed: 0, binary: false },
      ],
      upstreamPaths: new Set(['packages/fork/assembly.ts', '.github/workflows/sync.yml']),
    })

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'fork-owned-collision', entryId: 'composition', path: 'packages/fork/assembly.ts' }),
      expect.objectContaining({ code: 'fork-owned-collision', entryId: 'workflow', path: '.github/workflows/sync.yml' }),
    ])
  })

  it('reports an upstream file collision for a fork-side tree root', () => {
    const result = fixture({
      entries: [makeEntry('fork-tree', 'fork-owned', 'foo/', 'tree')],
      diffs: [{ status: 'M', path: 'foo', added: 1, removed: 0, binary: false }],
      upstreamPaths: new Set(['foo']),
    })

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'fork-owned-collision',
      entryId: 'fork-tree',
      path: 'foo',
    }))
  })

  it('does not duplicate ownership when one entry has exact and tree declarations', () => {
    const entry = makeEntry('same-entry', 'composition', 'packages/a/', 'tree')
    const result = fixture({
      entries: [{ ...entry, paths: [
        { path: 'packages/a/', coverage: 'tree' },
        { path: 'packages/a/file.ts', coverage: 'exact' },
      ] }],
      diffs: [{ status: 'M', path: 'packages/a/file.ts', added: 1, removed: 0, binary: false }],
    })

    expect(result.diagnostics).toEqual([])
  })

  it('rejects a patch diff that has no upstream anchor', () => {
    const result = fixture({
      entries: [makeEntry('new-patch', 'extension-patch', 'packages/upstream/new.ts', 'exact', {
        maxFiles: 1,
        maxChangedLines: 10,
      })],
      diffs: [{ status: 'A', path: 'packages/upstream/new.ts', added: 3, removed: 0, binary: false }],
      upstreamPaths: new Set(),
    })

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'upstream-ownership-mismatch',
      entryId: 'new-patch',
      path: 'packages/upstream/new.ts',
    }))
  })

  it('anchors patch deletion, rename, and copy records to any upstream path', () => {
    const cases = [
      {
        status: 'D' as const,
        path: 'packages/upstream/deleted.ts',
        added: 0,
        removed: 2,
        binary: false,
        upstreamPaths: ['packages/upstream/deleted.ts'],
      },
      {
        status: 'R' as const,
        oldPath: 'packages/upstream/old.ts',
        path: 'packages/upstream/new.ts',
        added: 2,
        removed: 1,
        binary: false,
        upstreamPaths: ['packages/upstream/old.ts'],
      },
      {
        status: 'C' as const,
        oldPath: 'packages/upstream/source.ts',
        path: 'packages/upstream/copy.ts',
        added: 1,
        removed: 0,
        binary: false,
        upstreamPaths: ['packages/upstream/source.ts'],
      },
    ]

    for (const diff of cases) {
      const result = fixture({
        entries: [makeEntry('upstream-patch', 'product-patch', 'packages/upstream/', 'tree', {
          maxFiles: 1,
          maxChangedLines: 10,
        })],
        diffs: [diff],
        upstreamPaths: new Set(diff.upstreamPaths),
      })

      expect(result.diagnostics).toEqual([])
    }
  })

  it('rejects a patch that exceeds its changed-line budget', () => {
    const result = fixture({
      entries: [makeEntry('small-patch', 'product-patch', 'packages/upstream/file.ts', 'exact', {
        maxFiles: 1,
        maxChangedLines: 4,
      })],
      diffs: [{ status: 'M', path: 'packages/upstream/file.ts', added: 3, removed: 2, binary: false }],
      upstreamPaths: new Set(['packages/upstream/file.ts']),
    })

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'budget-exceeded',
      entryId: 'small-patch',
    }))
  })

  it('rejects a patch tree that claims a whole package', () => {
    const result = fixture({
      entries: [makeEntry('workspace-patch', 'extension-patch', 'packages/client/ui-workspace/', 'tree', {
        maxFiles: 1,
        maxChangedLines: 10,
      })],
      diffs: [{
        status: 'M',
        path: 'packages/client/ui-workspace/src/index.ts',
        added: 1,
        removed: 1,
        binary: false,
      }],
      upstreamPaths: new Set(['packages/client/ui-workspace/src/index.ts']),
    })

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'whole-package-patch',
      entryId: 'workspace-patch',
      path: 'packages/client/ui-workspace/',
    }))
  })

  it('counts a rename once for patch budgets while checking both paths', () => {
    const result = fixture({
      entries: [makeEntry('rename-patch', 'product-patch', 'packages/upstream/', 'tree', {
        maxFiles: 1,
        maxChangedLines: 5,
      })],
      diffs: [{
        status: 'R',
        oldPath: 'packages/upstream/old.ts',
        path: 'packages/upstream/new.ts',
        added: 3,
        removed: 2,
        binary: false,
      }],
      upstreamPaths: new Set(['packages/upstream/old.ts']),
    })

    expect(result.diagnostics).toEqual([])
  })

  it('counts a binary change as one changed line', () => {
    const result = fixture({
      entries: [makeEntry('binary-patch', 'extension-patch', 'packages/upstream/image.png', 'exact', {
        maxFiles: 1,
        maxChangedLines: 1,
      })],
      diffs: [{
        status: 'M',
        path: 'packages/upstream/image.png',
        added: 0,
        removed: 0,
        binary: true,
      }],
      upstreamPaths: new Set(['packages/upstream/image.png']),
    })

    expect(result.diagnostics).toEqual([])
  })
})
