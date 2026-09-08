import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const SOURCE_PREFIX = '@deepseek-ai/dsh'
const TARGET_PREFIX = '@knyazevai/dsh'
const EXCLUDED_PREFIXES = [
  'vendor/',
  '.agents/notes/',
  'docs/superpowers/specs/',
  'docs/superpowers/plans/',
] as const
const EXCLUDED_SEGMENTS = ['/lib/', '/dist/', '/node_modules/'] as const
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonl', '.yml', '.yaml', '.md', '.py', '.snap',
])
const EXCLUDED_FILES = ['scripts/rescope-dsh.ts', 'scripts/rescope-dsh.spec.ts'] as const

/**
 * Whether a repository-relative tracked path is eligible for the DSH rescope.
 * @param path - repository-relative path reported by `git ls-files`.
 * @returns true when the path is a current UTF-8 text source file.
 */
export function eligibleDshRescopePath(path: string): boolean {
  if (EXCLUDED_FILES.some(file => file === path)) return false
  if (EXCLUDED_PREFIXES.some(prefix => path.startsWith(prefix))) return false
  if (EXCLUDED_SEGMENTS.some(segment => `/${path}`.includes(segment))) return false
  return TEXT_EXTENSIONS.has(extname(path))
}

/**
 * Replace the old DSH npm scope in text.
 * @param text - UTF-8 file contents.
 * @returns text with every old DSH scope replaced by the new scope.
 */
export function rescopeDshText(text: string): string {
  return text.replaceAll(SOURCE_PREFIX, TARGET_PREFIX)
}

type Mode = 'dry-run' | 'apply' | 'check'

/**
 * Parse the command mode, accepting one separator inserted by a package runner.
 * @param args - command-line arguments after the script path.
 * @returns the requested mode, or dry-run when no mode was supplied.
 */
export function parseDshRescopeMode(args: readonly string[]): Mode {
  const modeArgs = args[0] === '--' ? args.slice(1) : args
  let mode: Mode = 'dry-run'
  for (const arg of modeArgs) {
    if (arg !== '--apply' && arg !== '--check') {
      throw new Error(`unknown option ${JSON.stringify(arg)}; expected --apply or --check`)
    }
    if (mode !== 'dry-run') throw new Error('modes --apply and --check are mutually exclusive')
    mode = arg === '--apply' ? 'apply' : 'check'
  }
  return mode
}

interface Change {
  readonly file: string
  readonly before: string
  readonly after: string
}

function trackedFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  return output.toString('utf8').split('\0').filter(Boolean).sort()
}

function pendingChanges(): Change[] {
  const changes: Change[] = []
  for (const file of trackedFiles()) {
    if (!eligibleDshRescopePath(file)) continue
    const absolute = resolve(root, file)
    if (!existsSync(absolute)) continue
    const before = readFileSync(absolute, 'utf8')
    const after = rescopeDshText(before)
    if (after !== before) changes.push({ file, before, after })
  }
  return changes
}

function reportFiles(changes: readonly Change[]): void {
  for (const change of changes) process.stdout.write(`${change.file}\n`)
}

function main(args: readonly string[]): void {
  const mode = parseDshRescopeMode(args)
  const changes = pendingChanges()
  reportFiles(changes)

  if (mode === 'check') {
    if (changes.length > 0) {
      process.stderr.write(`rescope-dsh: ${String(changes.length)} stale eligible file(s)\n`)
      process.exitCode = 1
    } else {
      process.stdout.write('rescope-dsh: check passed; no stale eligible files\n')
    }
    return
  }

  if (mode === 'dry-run') {
    process.stdout.write(`rescope-dsh: dry-run; ${String(changes.length)} file(s) would change\n`)
    return
  }

  for (const change of changes) {
    writeFileSync(resolve(root, change.file), change.after, 'utf8')
  }

  const remaining = pendingChanges()
  if (remaining.length > 0) {
    throw new Error(`apply left stale eligible files: ${remaining.map(change => change.file).join(', ')}`)
  }
  process.stdout.write(`rescope-dsh: applied ${String(changes.length)} file(s); second pass clean\n`)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`rescope-dsh: ${message}\n`)
    process.exitCode = 1
  }
}
