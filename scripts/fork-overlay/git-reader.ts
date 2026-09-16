import { execFile } from 'node:child_process'
import { promisify, TextDecoder } from 'node:util'
import type { DiffEntry } from './types.ts'

/** Read-only Git facts for one repository root. */
export interface GitReader {
  /**
   * Check whether a string names an existing commit object.
   * @param commit Commit object name or immutable SHA.
   * @returns Whether Git can resolve the value to a commit.
   */
  commitExists(commit: string): Promise<boolean>
  /**
   * Read every path present in a commit tree.
   * @param commit Commit object name or immutable SHA.
   * @returns Repository-relative paths in the commit.
   */
  listTree(commit: string): Promise<ReadonlySet<string>>
  /**
   * Compare a commit with the current worktree.
   * @param commit Commit object name or immutable SHA.
   * @returns Rename-aware status and numstat facts.
   */
  diff(commit: string): Promise<readonly DiffEntry[]>
}

/** Maximum stdout or stderr captured from one repository Git command. */
export const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024

const execFileAsync = promisify(execFile)
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/**
 * Decode bytes emitted by Git without replacing malformed UTF-8.
 * @param output Git stdout bytes.
 * @returns The decoded UTF-8 text.
 * @throws TypeError when Git emits malformed UTF-8.
 */
export function decodeGitUtf8(output: Uint8Array): string {
  return UTF8_DECODER.decode(output)
}

type NameStatusRecord = {
  readonly status: DiffEntry['status']
  readonly path: string
  readonly oldPath?: string
}

type NumstatRecord = {
  readonly path: string
  readonly oldPath?: string
  readonly added: number
  readonly removed: number
  readonly binary: boolean
}

function nulSeparated(buffer: Buffer): readonly string[] {
  const values: string[] = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    if (index > start) values.push(decodeGitUtf8(buffer.subarray(start, index)))
    start = index + 1
  }
  if (start < buffer.length) values.push(decodeGitUtf8(buffer.subarray(start)))
  return values
}

function pathIdentity(path: string, oldPath?: string): string {
  return oldPath === undefined ? path : `${oldPath}\u0000${path}`
}

function knownStatus(value: string): DiffEntry['status'] {
  switch (value) {
    case 'A':
    case 'M':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
      return value
    default:
      throw new Error(`git diff returned unsupported status ${value}`)
  }
}

function parseNameStatus(buffer: Buffer): readonly NameStatusRecord[] {
  const fields = nulSeparated(buffer)
  const records: NameStatusRecord[] = []
  let index = 0
  while (index < fields.length) {
    const statusAndScore = fields[index++]
    if (statusAndScore === undefined || statusAndScore.length === 0) continue
    const status = knownStatus(statusAndScore[0] ?? '')
    if (status === 'R' || status === 'C') {
      const oldPath = fields[index++]
      const path = fields[index++]
      if (oldPath === undefined || path === undefined) throw new Error('git diff returned an incomplete rename record')
      records.push({ status, oldPath, path })
    } else {
      const path = fields[index++]
      if (path === undefined) throw new Error('git diff returned an incomplete name-status record')
      records.push({ status, path })
    }
  }
  return records
}

function parseCount(value: string): { readonly count: number; readonly binary: boolean } {
  if (value === '-') return { count: 0, binary: true }
  if (!/^\d+$/.test(value)) throw new Error(`git diff returned an invalid numstat count ${value}`)
  const count = Number(value)
  if (!Number.isSafeInteger(count)) throw new Error(`git diff returned an unsafe numstat count ${value}`)
  return { count, binary: false }
}

function parseNumstat(buffer: Buffer): readonly NumstatRecord[] {
  const fields = nulSeparated(buffer)
  const records: NumstatRecord[] = []
  let index = 0
  while (index < fields.length) {
    const header = fields[index++]
    if (header === undefined || header.length === 0) continue
    const firstTab = header.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : header.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) throw new Error('git diff returned an invalid numstat record')
    const addedValue = header.slice(0, firstTab)
    const removedValue = header.slice(firstTab + 1, secondTab)
    const pathValue = header.slice(secondTab + 1)
    const added = parseCount(addedValue)
    const removed = parseCount(removedValue)
    if (pathValue.length === 0) {
      const oldPath = fields[index++]
      const path = fields[index++]
      if (oldPath === undefined || path === undefined) throw new Error('git diff returned an incomplete numstat rename record')
      records.push({
        oldPath,
        path,
        added: added.count,
        removed: removed.count,
        binary: added.binary || removed.binary,
      })
    } else {
      records.push({
        path: pathValue,
        added: added.count,
        removed: removed.count,
        binary: added.binary || removed.binary,
      })
    }
  }
  return records
}

async function runGit(root: string, args: readonly string[]): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value
  }
  env.GIT_OPTIONAL_LOCKS = '0'
  const result = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root,
    encoding: 'buffer',
    env,
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  })
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
}

function exitCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'number' ? code : undefined
}

function joinDiffs(
  nameStatuses: readonly NameStatusRecord[],
  numstats: readonly NumstatRecord[],
): readonly DiffEntry[] {
  const byIdentity = new Map<string, NumstatRecord>()
  for (const numstat of numstats) {
    const identity = pathIdentity(numstat.path, numstat.oldPath)
    if (byIdentity.has(identity)) throw new Error(`git diff returned duplicate numstat path ${identity}`)
    byIdentity.set(identity, numstat)
  }

  const diffs: DiffEntry[] = []
  for (const nameStatus of nameStatuses) {
    const identity = pathIdentity(nameStatus.path, nameStatus.oldPath)
    const numstat = byIdentity.get(identity)
    if (numstat === undefined) throw new Error(`git diff did not return numstat for ${identity}`)
    byIdentity.delete(identity)
    diffs.push({
      status: nameStatus.status,
      path: nameStatus.path,
      ...(nameStatus.oldPath === undefined ? {} : { oldPath: nameStatus.oldPath }),
      added: numstat.added,
      removed: numstat.removed,
      binary: numstat.binary,
    })
  }
  if (byIdentity.size > 0) throw new Error('git diff returned numstat records without statuses')
  return diffs
}

/**
 * Create a read-only adapter over Git commands rooted at a repository.
 * @param root Absolute or relative repository root passed to Git as cwd.
 * @returns Git facts adapter.
 */
export function createGitReader(root: string): GitReader {
  return {
    async commitExists(commit: string): Promise<boolean> {
      try {
        await runGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`])
        return true
      } catch (error: unknown) {
        if (exitCode(error) === 1) return false
        throw error
      }
    },

    async listTree(commit: string): Promise<ReadonlySet<string>> {
      const output = await runGit(root, ['ls-tree', '-r', '-z', '--name-only', '--end-of-options', commit])
      return new Set(nulSeparated(output))
    },

    async diff(commit: string): Promise<readonly DiffEntry[]> {
      const [nameStatusOutput, numstatOutput] = await Promise.all([
        runGit(root, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--ignore-submodules=none',
          '--name-status', '-z', '-M', '--end-of-options', commit, '--',
        ]),
        runGit(root, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--ignore-submodules=none',
          '--numstat', '-z', '-M', '--end-of-options', commit, '--',
        ]),
      ])
      return joinDiffs(parseNameStatus(nameStatusOutput), parseNumstat(numstatOutput))
    },
  }
}
