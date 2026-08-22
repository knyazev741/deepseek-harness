/**
 * Read-only source-plane overlay verifier. The command validates the manifest,
 * checks Git classification and target declarations, and never runs targets.
 * @module scripts/verify-fork-overlay
 */

import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createGitReader } from './fork-overlay/git-reader.ts'
import { parseOverlayManifest } from './fork-overlay/manifest.ts'
import { verifyOverlay } from './fork-overlay/verify.ts'
import type { OverlayDiagnostic } from './fork-overlay/types.ts'

const DEFAULT_MANIFEST_PATH = '.fork/overlay.yaml'
const ARGUMENT_ERROR = 'expected zero arguments or --manifest <repository-relative-path>'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function manifestArgument(args: readonly string[]): string {
  if (args.length === 0) return DEFAULT_MANIFEST_PATH
  if (args.length !== 2 || args[0] !== '--manifest' || args[1] === undefined) {
    throw new Error(ARGUMENT_ERROR)
  }
  return args[1]
}

function resolveManifestPath(root: string, path: string): string {
  if (path.length === 0 || path.includes('\u0000')) {
    throw new Error('manifest path must be repository-relative and must not contain traversal')
  }
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)
    || path.includes('\\') || path.split('/').some(segment => segment === '..')) {
    throw new Error('manifest path must be repository-relative and must not contain traversal')
  }

  const candidate = resolve(root, path)
  const fromRoot = relative(root, candidate)
  if (fromRoot.length === 0 || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('manifest path must be repository-relative and must not contain traversal')
  }
  return candidate
}

async function rejectSymlinkComponents(root: string, path: string): Promise<void> {
  let current = root
  for (const segment of relative(root, path).split(sep)) {
    if (segment.length === 0 || segment === '.') continue
    current = join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error('manifest path must not traverse a symlink')
      }
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break
      throw error
    }
  }
}

function diagnosticOrder(left: OverlayDiagnostic, right: OverlayDiagnostic): number {
  const byCode = compareText(left.code, right.code)
  if (byCode !== 0) return byCode
  const byEntry = compareText(left.entryId ?? '', right.entryId ?? '')
  if (byEntry !== 0) return byEntry
  const byPath = compareText(left.path ?? '', right.path ?? '')
  if (byPath !== 0) return byPath
  return compareText(left.message, right.message)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function diagnosticLine(diagnostic: OverlayDiagnostic): string {
  const code = diagnostic.code.replaceAll('-', '_').toUpperCase()
  const fields = [
    ...(diagnostic.entryId === undefined ? [] : [`entry=${diagnostic.entryId}`]),
    ...(diagnostic.path === undefined ? [] : [`path=${diagnostic.path}`]),
  ]
  return `${code}${fields.length === 0 ? '' : ` ${fields.join(' ')}`}: ${diagnostic.message}`
}

async function verifyRepository(root: string, args: readonly string[]): Promise<number> {
  const relativeManifestPath = manifestArgument(args)
  const manifestPath = resolveManifestPath(root, relativeManifestPath)
  await rejectSymlinkComponents(root, manifestPath)
  const text = await readFile(manifestPath, 'utf8')
  const manifest = parseOverlayManifest(text, relativeManifestPath)
  const diagnostics = [...await verifyOverlay({
    root,
    manifest,
    git: createGitReader(root),
  })].sort(diagnosticOrder)

  if (diagnostics.length === 0) {
    process.stdout.write('fork-overlay: PASS\n')
    return 0
  }
  for (const diagnostic of diagnostics) process.stderr.write(`${diagnosticLine(diagnostic)}\n`)
  return 1
}

async function main(args: readonly string[]): Promise<number> {
  const root = resolve(process.cwd())
  try {
    return await verifyRepository(root, args)
  } catch (error: unknown) {
    process.stderr.write(`fork-overlay: ERROR ${errorMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  void main(process.argv.slice(2)).then(status => process.exit(status))
}
