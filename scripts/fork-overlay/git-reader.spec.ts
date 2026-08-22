import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitReader, decodeGitUtf8, GIT_OUTPUT_MAX_BYTES } from './git-reader.ts'

const execFileAsync = promisify(execFile)
const temporaryRepositories: string[] = []

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: root, encoding: 'utf8' })
  return result.stdout
}

async function createRepository(): Promise<{
  readonly root: string
  readonly firstCommit: string
  readonly secondCommit: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-git-reader-'))
  temporaryRepositories.push(root)
  await runGit(root, ['init', '--quiet'])
  await runGit(root, ['config', 'user.name', 'Overlay Test'])
  await runGit(root, ['config', 'user.email', 'overlay@example.test'])
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'old name.spec.ts'), 'one\ntwo\nthree\n')
  await runGit(root, ['add', '--all'])
  await runGit(root, ['commit', '--quiet', '-m', 'initial'])
  const firstCommit = (await runGit(root, ['rev-parse', 'HEAD'])).trim()

  await runGit(root, ['mv', 'src/old name.spec.ts', 'src/new name.spec.ts'])
  await writeFile(join(root, 'src', 'new name.spec.ts'), 'one\ntwo\nthree\nfour\n')
  await runGit(root, ['add', '--all'])
  await runGit(root, ['commit', '--quiet', '-m', 'rename'])
  const secondCommit = (await runGit(root, ['rev-parse', 'HEAD'])).trim()
  return { root, firstCommit, secondCommit }
}

async function createSubmoduleRepository(): Promise<{
  readonly root: string
  readonly firstCommit: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-submodule-root-'))
  const source = await mkdtemp(join(tmpdir(), 'dsh-overlay-submodule-source-'))
  temporaryRepositories.push(root, source)
  await runGit(source, ['init', '--quiet'])
  await runGit(source, ['config', 'user.name', 'Overlay Test'])
  await runGit(source, ['config', 'user.email', 'overlay@example.test'])
  await writeFile(join(source, 'file.txt'), 'one\n')
  await runGit(source, ['add', '--all'])
  await runGit(source, ['commit', '--quiet', '-m', 'submodule initial'])

  await runGit(root, ['init', '--quiet'])
  await runGit(root, ['config', 'user.name', 'Overlay Test'])
  await runGit(root, ['config', 'user.email', 'overlay@example.test'])
  await runGit(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', source, 'nested'])
  await runGit(root, ['commit', '--quiet', '-m', 'root initial'])
  const firstCommit = (await runGit(root, ['rev-parse', 'HEAD'])).trim()
  await writeFile(join(root, 'nested', 'file.txt'), 'two\n')
  await runGit(root, ['config', 'submodule.nested.ignore', 'all'])
  return { root, firstCommit }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  const roots = temporaryRepositories.splice(0)
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

describe('createGitReader', () => {
  it('reads spaces, trees, and rename records without lossy parsing', async () => {
    const repository = await createRepository()
    const reader = createGitReader(repository.root)

    expect(await reader.commitExists(repository.firstCommit)).toBe(true)
    expect(await reader.commitExists(repository.secondCommit)).toBe(true)
    expect(await reader.listTree(repository.firstCommit)).toEqual(new Set(['src/old name.spec.ts']))
    expect(await reader.listTree(repository.secondCommit)).toEqual(new Set(['src/new name.spec.ts']))
    expect(await reader.diff(repository.firstCommit)).toEqual([{
      status: 'R',
      oldPath: 'src/old name.spec.ts',
      path: 'src/new name.spec.ts',
      added: 1,
      removed: 0,
      binary: false,
    }])
  })

  it('reports a commit that is not present as missing', async () => {
    const repository = await createRepository()
    const reader = createGitReader(repository.root)

    expect(await reader.commitExists('f'.repeat(40))).toBe(false)
  })

  it('ignores case-insensitive GIT_* redirection variables', async () => {
    const repository = await createRepository()
    const redirected = await createRepository()
    const previous = new Map<string, string | undefined>([
      ['GIT_DIR', process.env.GIT_DIR],
      ['gIt_WORK_TREE', process.env.gIt_WORK_TREE],
    ])
    process.env.GIT_DIR = join(redirected.root, '.git')
    process.env.gIt_WORK_TREE = redirected.root
    try {
      const reader = createGitReader(repository.root)

      expect(await reader.listTree(repository.firstCommit)).toEqual(new Set(['src/old name.spec.ts']))
      expect(await reader.diff(repository.firstCommit)).toEqual([{
        status: 'R',
        oldPath: 'src/old name.spec.ts',
        path: 'src/new name.spec.ts',
        added: 1,
        removed: 0,
        binary: false,
      }])
    } finally {
      const previousGitDir = previous.get('GIT_DIR')
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
      const previousWorkTree = previous.get('gIt_WORK_TREE')
      if (previousWorkTree === undefined) delete process.env.gIt_WORK_TREE
      else process.env.gIt_WORK_TREE = previousWorkTree
    }
  })

  it('treats option-like revisions as revisions for tree and diff reads', async () => {
    const repository = await createRepository()
    const reader = createGitReader(repository.root)

    await expect(reader.listTree('--all')).rejects.toThrow()
    await expect(reader.diff('--all')).rejects.toThrow()
  })

  it('propagates operational failures instead of treating them as missing commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-not-a-repository-'))
    temporaryRepositories.push(root)
    const reader = createGitReader(root)

    await expect(reader.commitExists('f'.repeat(40))).rejects.toThrow(/not a git repository/i)
  })

  it('does not allow Git helper configuration to run or hide submodule changes', async () => {
    const repository = await createRepository()
    const helper = join(repository.root, 'configured helper.sh')
    const marker = join(repository.root, 'external-helper-ran')
    const shellMarker = marker.replaceAll("'", "'\\''")
    await writeFile(helper, `#!/bin/sh\nprintf ran > '${shellMarker}'\nexit 1\n`)
    await chmod(helper, 0o755)
    await runGit(repository.root, ['config', 'diff.external', helper])
    await runGit(repository.root, ['config', 'core.fsmonitor', helper])
    const reader = createGitReader(repository.root)

    const diff = await reader.diff(repository.firstCommit)

    expect(diff).toEqual([{
      status: 'R',
      oldPath: 'src/old name.spec.ts',
      path: 'src/new name.spec.ts',
      added: 1,
      removed: 0,
      binary: false,
    }])
    expect(await pathExists(marker)).toBe(false)

    const submodule = await createSubmoduleRepository()
    const submoduleDiff = await createGitReader(submodule.root).diff(submodule.firstCommit)
    expect(submoduleDiff).toEqual([{
      status: 'M',
      path: 'nested',
      added: 0,
      removed: 0,
      binary: false,
    }])
  })

  it('uses a repository-sized output bound and rejects malformed UTF-8', () => {
    expect(GIT_OUTPUT_MAX_BYTES).toBeGreaterThan(1024 * 1024)
    expect(() => decodeGitUtf8(Uint8Array.of(0xff))).toThrow()
  })
})
