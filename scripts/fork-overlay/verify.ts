import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { classifyOverlay } from './classify.ts'
import type { GitReader } from './git-reader.ts'
import type { OverlayDiagnostic, OverlayManifest, OverlayEntry, VerificationTarget } from './types.ts'

/** Inputs for validating one parsed overlay manifest against a repository. */
export interface VerifyOverlayInput {
  /** Repository root used for Git and filesystem facts. */
  readonly root: string
  /** Parsed and semantically validated overlay manifest. */
  readonly manifest: OverlayManifest
  /** Read-only Git adapter for the repository root. */
  readonly git: GitReader
}

type PackageJson = {
  readonly scripts?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function loadPackageJson(root: string): Promise<PackageJson | undefined> {
  try {
    const text = await readFile(resolve(root, 'package.json'), 'utf8')
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isRepositoryRelativeFile(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\u0000')) return false
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false
  if (path.includes('\\')) return false
  return !path.split('/').some(segment => segment === '..')
}

function isSupportedVitestFile(path: string): boolean {
  return path.endsWith('.spec.ts')
    || path.endsWith('.spec.tsx')
    || path.endsWith('.e2e.ts')
    || path.endsWith('.test.mjs')
}

async function canonicalRepositoryRoot(root: string): Promise<string | undefined> {
  try {
    return await realpath(root)
  } catch {
    return undefined
  }
}

async function isRegularFileWithinRoot(
  canonicalRoot: string | undefined,
  root: string,
  path: string,
): Promise<boolean> {
  if (canonicalRoot === undefined) return false
  const candidate = resolve(root, path)
  try {
    if (!(await lstat(candidate)).isFile()) return false
    const canonicalTarget = await realpath(candidate)
    const relativeTarget = relative(canonicalRoot, canonicalTarget)
    return relativeTarget.length > 0
      && !isAbsolute(relativeTarget)
      && relativeTarget !== '..'
      && !relativeTarget.startsWith(`..${sep}`)
  } catch {
    return false
  }
}

function invalidTarget(entry: OverlayEntry, message: string, path?: string): OverlayDiagnostic {
  return {
    code: 'invalid-verification-target',
    message,
    entryId: entry.id,
    ...(path === undefined ? {} : { path }),
  }
}

function validScriptTarget(packageJson: PackageJson | undefined, target: VerificationTarget & { kind: 'script' }): boolean {
  if (!isRecord(packageJson?.scripts)) return false
  const script = packageJson.scripts[target.name]
  return typeof script === 'string' && script.length > 0
}

async function verificationDiagnostics(
  root: string,
  manifest: OverlayManifest,
  packageJson: PackageJson | undefined,
): Promise<readonly OverlayDiagnostic[]> {
  const diagnostics: OverlayDiagnostic[] = []
  const canonicalRoot = await canonicalRepositoryRoot(root)
  for (const entry of manifest.entries) {
    for (const target of entry.verify) {
      if (target.kind === 'script') {
        if (!validScriptTarget(packageJson, target)) {
          diagnostics.push(invalidTarget(
            entry,
            `script target ${JSON.stringify(target.name)} is not a non-empty package.json script`,
          ))
        }
        continue
      }

      if (target.files.length === 0) {
        diagnostics.push(invalidTarget(entry, 'Vitest target must contain at least one file'))
        continue
      }
      for (const file of target.files) {
        if (!isRepositoryRelativeFile(file)
          || !isSupportedVitestFile(file)
          || !(await isRegularFileWithinRoot(canonicalRoot, root, file))) {
          diagnostics.push(invalidTarget(
            entry,
            `Vitest target file ${JSON.stringify(file)} is not a repository-relative regular test file`,
            file,
          ))
        }
      }
    }
  }
  return diagnostics
}

function diagnosticOrder(left: OverlayDiagnostic, right: OverlayDiagnostic): number {
  const byCode = left.code.localeCompare(right.code)
  if (byCode !== 0) return byCode
  const byEntry = (left.entryId ?? '').localeCompare(right.entryId ?? '')
  if (byEntry !== 0) return byEntry
  const byPath = (left.path ?? '').localeCompare(right.path ?? '')
  if (byPath !== 0) return byPath
  return left.message.localeCompare(right.message)
}

/**
 * Validate a parsed overlay manifest against Git, filesystem targets, and real package scripts.
 * @param input Repository, manifest, and read-only Git adapter.
 * @returns Deterministically ordered diagnostics; an empty list means valid.
 */
export async function verifyOverlay(input: VerifyOverlayInput): Promise<readonly OverlayDiagnostic[]> {
  const { git, manifest, root } = input
  if (!(await git.commitExists(manifest.upstreamCommit))) {
    return [{
      code: 'upstream-commit-missing',
      message: `upstream commit ${manifest.upstreamCommit} is not present`,
    }]
  }

  const [upstreamPaths, diffs, packageJson] = await Promise.all([
    git.listTree(manifest.upstreamCommit),
    git.diff(manifest.upstreamCommit),
    loadPackageJson(root),
  ])
  const classification = classifyOverlay({ manifest, diffs, upstreamPaths })
  const targetDiagnostics = await verificationDiagnostics(root, manifest, packageJson)
  return [...classification.diagnostics, ...targetDiagnostics].sort(diagnosticOrder)
}
