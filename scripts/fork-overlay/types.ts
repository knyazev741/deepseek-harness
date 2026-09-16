/** A declared class of fork overlay ownership or integration. */
export type OverlayKind =
  | 'fork-owned'
  | 'composition'
  | 'extension-patch'
  | 'product-patch'
  | 'workflow'

/** A repository-relative path and whether it covers one path or a tree. */
export interface OverlayPath {
  readonly path: string
  readonly coverage: 'exact' | 'tree'
}

/** A repository script or a list of focused Vitest files used for verification. */
export type VerificationTarget =
  | { readonly kind: 'script'; readonly name: string }
  | { readonly kind: 'vitest'; readonly files: readonly string[] }

/** File and changed-line limits for an upstream-owned patch entry. */
export interface PatchBudget {
  readonly maxFiles: number
  readonly maxChangedLines: number
}

/** One owned or patched portion of the fork overlay. */
export interface OverlayEntry {
  readonly id: string
  readonly kind: OverlayKind
  readonly paths: readonly OverlayPath[]
  readonly owner: string
  readonly agentNote: string
  readonly verify: readonly VerificationTarget[]
  readonly retireWhen: string
  readonly budget?: PatchBudget
  readonly generatedBy?: string
}

/** The immutable upstream commit and declared overlay entries. */
export interface OverlayManifest {
  readonly schemaVersion: 1
  readonly upstreamCommit: string
  readonly entries: readonly OverlayEntry[]
}

/** One changed path and its Git numstat facts. */
export interface DiffEntry {
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
  readonly path: string
  readonly oldPath?: string
  readonly added: number
  readonly removed: number
  readonly binary: boolean
}

/** A deterministic failure found while classifying the overlay. */
export interface OverlayDiagnostic {
  readonly code:
    | 'uncovered-path' | 'overlapping-coverage' | 'stale-entry'
    | 'fork-owned-collision' | 'whole-package-patch' | 'budget-exceeded'
    | 'upstream-ownership-mismatch' | 'invalid-verification-target'
    | 'upstream-commit-missing'
  readonly message: string
  readonly entryId?: string
  readonly path?: string
}

/** Inputs needed to classify one candidate tree against an overlay manifest. */
export interface ClassificationInput {
  readonly manifest: OverlayManifest
  readonly diffs: readonly DiffEntry[]
  readonly upstreamPaths: ReadonlySet<string>
}

/** Classification diagnostics for one candidate tree. */
export interface ClassificationResult {
  readonly diagnostics: readonly OverlayDiagnostic[]
}
