import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitReader } from './git-reader.ts'

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
})
