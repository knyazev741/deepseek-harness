/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root, optional host-owned state root, and platform temp areas",
 * and this module is that meaning's one home. The Seatbelt profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The bwrap and Landlock dialects keep their own grant spellings (an
 * ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
 * differences recorded in the sandbox RFC — with parity pinned by test.
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { SandboxExecutionPolicy } from './index.ts'

/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or the spelling as-is when resolution fails
 *   (a missing root matches nothing until it exists — the conservative
 *   outcome; inventing a fallback would grant a path the caller never named).
 */
export function canonicalPath(path: string): string {
  try {
    // Node's JavaScript realpath implementation lexically collapses `..`
    // before resolving a preceding symlink on some platforms. The native
    // implementation follows the filesystem's component-by-component lookup,
    // matching chdir/spawn and the enforcement layers this identity feeds.
    return realpathSync.native(path)
  } catch {
    // realpathSync.native failed: the path (or a prefix) is missing or unreadable.
    return path
  }
}

/**
 * Resolve and validate the optional host-owned state directory. Missing
 * paths remain absolute and are left for the caller-owned directory setup to
 * report; a relative path is rejected before any runner argv is built.
 * @param stateRoot - the optional state directory from a per-call policy.
 * @returns the canonical absolute state directory, or `undefined` when absent.
 */
export function canonicalStateRoot(stateRoot: string | undefined): string | undefined {
  if (stateRoot === undefined) return undefined
  const canonical = canonicalPath(stateRoot)
  if (!isAbsolute(canonical)) throw new Error('sandbox stateRoot must be absolute')
  return canonical
}

/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, optional state root,
 * host `/tmp`, and per-user platform temp dir (`os.tmpdir()` — the real temp
 * area for mkstemp-family tools; omitting it would deny what the mode
 * promises). Every configured state root is absolute after canonicalization.
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  const stateRoot = canonicalStateRoot(policy.stateRoot)
  return [...new Set([
    policy.workspaceRoot,
    ...(stateRoot === undefined ? [] : [stateRoot]),
    '/tmp',
    tmpdir(),
  ].map(canonicalPath))]
}
