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
