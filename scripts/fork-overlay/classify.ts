import type {
  ClassificationInput,
  ClassificationResult,
  DiffEntry,
  OverlayDiagnostic,
  OverlayEntry,
  OverlayPath,
} from './types.ts'

export type {
  ClassificationInput,
  ClassificationResult,
  DiffEntry,
  OverlayDiagnostic,
} from './types.ts'

type CoverageMatch = {
  readonly entry: OverlayEntry
  readonly path: OverlayPath
}

type BudgetUsage = {
  readonly diffIndexes: Set<number>
  changedLines: number
}

function matchesPath(declaredPath: OverlayPath, path: string): boolean {
  if (declaredPath.coverage === 'exact') return declaredPath.path === path
  return declaredPath.path.endsWith('/') && path.startsWith(declaredPath.path)
}

function matchingEntries(entries: readonly OverlayEntry[], path: string): readonly CoverageMatch[] {
  const matches: CoverageMatch[] = []
  for (const entry of entries) {
    for (const declaredPath of entry.paths) {
      if (matchesPath(declaredPath, path)) matches.push({ entry, path: declaredPath })
    }
  }
  return matches
}

function uniqueEntries(matches: readonly CoverageMatch[]): readonly OverlayEntry[] {
  const entries = new Map<string, OverlayEntry>()
  for (const match of matches) entries.set(match.entry.id, match.entry)
  return [...entries.values()]
}

function changedPaths(diff: DiffEntry): readonly string[] {
  return (diff.status === 'R' || diff.status === 'C') && diff.oldPath !== undefined
    ? [diff.oldPath, diff.path]
    : [diff.path]
}

function isPatch(entry: OverlayEntry): boolean {
  return entry.kind === 'extension-patch' || entry.kind === 'product-patch'
}

function isForkSide(entry: OverlayEntry): boolean {
  return entry.kind === 'fork-owned' || entry.kind === 'composition' || entry.kind === 'workflow'
}

function isWholePackagePath(declaredPath: OverlayPath): boolean {
  if (declaredPath.coverage !== 'tree') return false
  const segments = declaredPath.path.split('/').filter(segment => segment.length > 0)
  return segments.length === 3 && segments[0] === 'packages'
}

function changedLines(diff: DiffEntry): number {
  return diff.binary ? 1 : diff.added + diff.removed
}

function hasUpstreamAnchor(diff: DiffEntry, upstreamPaths: ReadonlySet<string>): boolean {
  return changedPaths(diff).some(path => upstreamPaths.has(path))
}

function matchesUpstreamPath(declaredPath: OverlayPath, upstreamPath: string): boolean {
  if (declaredPath.coverage === 'exact') return declaredPath.path === upstreamPath
  const treeRoot = declaredPath.path.slice(0, -1)
  return upstreamPath === treeRoot || upstreamPath.startsWith(declaredPath.path)
}

function diagnosticOrder(left: OverlayDiagnostic, right: OverlayDiagnostic): number {
  const byCode = left.code.localeCompare(right.code)
  if (byCode !== 0) return byCode
  const byEntry = (left.entryId ?? '').localeCompare(right.entryId ?? '')
  if (byEntry !== 0) return byEntry
  return (left.path ?? '').localeCompare(right.path ?? '')
}

function pushDiagnostic(diagnostics: OverlayDiagnostic[], diagnostic: OverlayDiagnostic): void {
  diagnostics.push(diagnostic)
}

/**
 * Classify candidate Git changes against the declared overlay exactly once.
 * @param input Manifest, candidate diff facts, and paths present in upstream.
 * @returns Deterministically ordered classification diagnostics.
 */
export function classifyOverlay(input: ClassificationInput): ClassificationResult {
  const { entries } = input.manifest
  const diagnostics: OverlayDiagnostic[] = []
  const changedEntryIds = new Set<string>()
  const budgetUsage = new Map<string, BudgetUsage>()

  for (const [diffIndex, diff] of input.diffs.entries()) {
    const ownersForDiff = new Map<string, OverlayEntry>()
    for (const path of changedPaths(diff)) {
      const matches = matchingEntries(entries, path)
      const owners = uniqueEntries(matches)
      if (owners.length === 0) {
        pushDiagnostic(diagnostics, {
          code: 'uncovered-path',
          message: 'path is not covered by an overlay entry',
          path,
        })
      } else {
        for (const owner of owners) {
          changedEntryIds.add(owner.id)
          ownersForDiff.set(owner.id, owner)
        }
        if (owners.length > 1) {
          pushDiagnostic(diagnostics, {
            code: 'overlapping-coverage',
            message: 'path is covered by multiple overlay entries',
            path,
          })
        }
      }
    }

    for (const owner of ownersForDiff.values()) {
      if (!isPatch(owner)) continue
      if (!hasUpstreamAnchor(diff, input.upstreamPaths)) {
        pushDiagnostic(diagnostics, {
          code: 'upstream-ownership-mismatch',
          message: 'upstream-owned patch diff has no path present in upstream',
          entryId: owner.id,
          path: diff.path,
        })
      }
      const budget = owner.budget
      if (budget === undefined) continue
      const usage = budgetUsage.get(owner.id) ?? { diffIndexes: new Set<number>(), changedLines: 0 }
      if (!usage.diffIndexes.has(diffIndex)) {
        usage.diffIndexes.add(diffIndex)
        usage.changedLines += changedLines(diff)
      }
      budgetUsage.set(owner.id, usage)
    }
  }

  for (const entry of entries) {
    if (!changedEntryIds.has(entry.id)) {
      pushDiagnostic(diagnostics, {
        code: 'stale-entry',
        message: 'overlay entry has no changed paths',
        entryId: entry.id,
      })
    }

    if (isPatch(entry)) {
      for (const declaredPath of entry.paths) {
        if (isWholePackagePath(declaredPath)) {
          pushDiagnostic(diagnostics, {
            code: 'whole-package-patch',
            message: 'patch tree claims an entire upstream package',
            entryId: entry.id,
            path: declaredPath.path,
          })
        }
      }

      const budget = entry.budget
      const usage = budgetUsage.get(entry.id)
      if (budget !== undefined && usage !== undefined
        && (usage.diffIndexes.size > budget.maxFiles || usage.changedLines > budget.maxChangedLines)) {
        pushDiagnostic(diagnostics, {
          code: 'budget-exceeded',
          message: `patch exceeds budget (files ${usage.diffIndexes.size}/${budget.maxFiles}, changed lines ${usage.changedLines}/${budget.maxChangedLines})`,
          entryId: entry.id,
        })
      }
    }
  }

  const collisionKeys = new Set<string>()
  for (const entry of entries) {
    if (!isForkSide(entry)) continue
    for (const upstreamPath of input.upstreamPaths) {
      const matches = entry.paths.some(declaredPath => matchesUpstreamPath(declaredPath, upstreamPath))
      if (!matches) continue
      const key = `${entry.id}\u0000${upstreamPath}`
      if (collisionKeys.has(key)) continue
      collisionKeys.add(key)
      pushDiagnostic(diagnostics, {
        code: 'fork-owned-collision',
        message: 'fork-side path exists in upstream',
        entryId: entry.id,
        path: upstreamPath,
      })
    }
  }

  diagnostics.sort(diagnosticOrder)
  return { diagnostics }
}
