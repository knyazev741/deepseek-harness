import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const temporaryRepositories: string[] = []
const repositoryRoot = process.cwd()
const tsxEntrypoint = join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
const cliEntrypoint = join(repositoryRoot, 'scripts', 'verify-fork-overlay.ts')

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: root, encoding: 'utf8' })
  return result.stdout
}

type CliResult = {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

async function runCli(root: string, args: readonly string[] = []): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', tsxEntrypoint, cliEntrypoint, ...args], {
      cwd: root,
      encoding: 'utf8',
    })
    return { status: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error)) throw error
    const code = error.code
    if (typeof code !== 'number') throw error
    const output = error as Error & { readonly stdout?: string; readonly stderr?: string }
    return {
      status: code,
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
    }
  }
}

async function createRepository(): Promise<{ readonly root: string; readonly upstreamCommit: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-verify-fork-overlay-'))
  temporaryRepositories.push(root)
  await runGit(root, ['init', '--quiet'])
  await runGit(root, ['config', 'user.name', 'Overlay Test'])
  await runGit(root, ['config', 'user.email', 'overlay@example.test'])
  await mkdir(join(root, 'packages', 'upstream'), { recursive: true })
  await mkdir(join(root, 'packages', 'upstream', 'a'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'overlay-fixture',
    scripts: {
      'test:fixture': "node -e \"require('node:fs').writeFileSync('verification-target-ran', 'yes')\"",
    },
  }, null, 2)}\n`)
  await writeFile(join(root, 'tests', 'fixture.spec.ts'), 'export {}\n')
  await writeFile(join(root, 'tracked.ts'), 'before\n')
  await writeFile(join(root, 'packages', 'upstream', 'file.ts'), 'before\n')
  await writeFile(join(root, 'packages', 'upstream', 'a', 'file.ts'), 'before\n')
  await writeFile(join(root, 'packages', 'upstream', 'z.ts'), 'before\n')
  await runGit(root, ['add', '--all'])
  await runGit(root, ['commit', '--quiet', '-m', 'fixture'])
  const upstreamCommit = (await runGit(root, ['rev-parse', 'HEAD'])).trim()
  await writeFile(join(root, 'tracked.ts'), 'after\n')
  return { root, upstreamCommit }
}

function manifestYaml(upstreamCommit: string, path: string): string {
  return `schemaVersion: 1
upstreamCommit: ${upstreamCommit}
entries:
  - id: fixture
    kind: product-patch
    paths:
      - path: ${path}
        coverage: exact
    owner: packages/fixture
    agentNote: .agents/notes/implemented/architecture/fixture.md
    verify:
      - kind: script
        name: test:fixture
      - kind: vitest
        files:
          - tests/fixture.spec.ts
    retireWhen: upstream provides the fixture behavior
    budget:
      maxFiles: 1
      maxChangedLines: 2
`
}

async function writeManifest(root: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = join(root, relativePath)
  const directory = absolutePath.slice(0, absolutePath.lastIndexOf('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(absolutePath, content)
}

async function createRepositoryWithDefaultManifest(): Promise<{ readonly root: string; readonly upstreamCommit: string }> {
  const repository = await createRepository()
  await writeManifest(
    repository.root,
    '.fork/overlay.yaml',
    manifestYaml(repository.upstreamCommit, 'tracked.ts'),
  )
  return repository
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  const roots = temporaryRepositories.splice(0)
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

describe('verify-fork-overlay CLI', () => {
  it('uses .fork/overlay.yaml by default and does not execute verification targets', async () => {
    const repository = await createRepositoryWithDefaultManifest()

    const result = await runCli(repository.root)

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('fork-overlay: PASS')
    expect(result.stderr).toBe('')
    expect(await fileExists(join(repository.root, 'verification-target-ran'))).toBe(false)
  })

  it('accepts an explicit .fork/overlay.yaml manifest and does not execute verification targets', async () => {
    const repository = await createRepositoryWithDefaultManifest()

    const result = await runCli(repository.root, ['--manifest', '.fork/overlay.yaml'])

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('fork-overlay: PASS')
    expect(result.stderr).toBe('')
    expect(await fileExists(join(repository.root, 'verification-target-ran'))).toBe(false)
  })

  it('accepts a repository-relative fixture manifest and reports uncovered paths stably', async () => {
    const repository = await createRepository()
    await writeFile(join(repository.root, 'packages', 'upstream', 'file.ts'), 'after\n')
    await writeManifest(
      repository.root,
      'fixtures/overlay.yaml',
      manifestYaml(repository.upstreamCommit, 'tracked.ts'),
    )

    const result = await runCli(repository.root, ['--manifest', 'fixtures/overlay.yaml'])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      'UNCOVERED_PATH path=packages/upstream/file.ts: path is not covered by an overlay entry',
    )
    expect(await fileExists(join(repository.root, 'verification-target-ran'))).toBe(false)
  })

  it('sorts same-code diagnostics by path', async () => {
    const repository = await createRepository()
    await writeFile(join(repository.root, 'packages', 'upstream', 'a', 'file.ts'), 'after\n')
    await writeFile(join(repository.root, 'packages', 'upstream', 'file.ts'), 'after\n')
    await writeFile(join(repository.root, 'packages', 'upstream', 'z.ts'), 'after\n')
    await writeManifest(
      repository.root,
      'fixtures/overlay.yaml',
      manifestYaml(repository.upstreamCommit, 'tracked.ts'),
    )

    const result = await runCli(repository.root, ['--manifest', 'fixtures/overlay.yaml'])
    const first = 'UNCOVERED_PATH path=packages/upstream/a/file.ts:'
    const second = 'UNCOVERED_PATH path=packages/upstream/file.ts:'
    const third = 'UNCOVERED_PATH path=packages/upstream/z.ts:'

    expect(result.status).toBe(1)
    expect(result.stderr.indexOf(first)).toBeLessThan(result.stderr.indexOf(second))
    expect(result.stderr.indexOf(second)).toBeLessThan(result.stderr.indexOf(third))
  })

  it.each([
    [['--manifest'], 'expected zero arguments or --manifest <repository-relative-path>'],
    [['unexpected'], 'expected zero arguments or --manifest <repository-relative-path>'],
    [['--manifest', '../outside.yaml'], 'manifest path must be repository-relative and must not contain traversal'],
  ] as const)('rejects invalid arguments: %j', async (args, message) => {
    const result = await runCli(repositoryRoot, args)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
  })

  it('rejects a manifest path that traverses a symlink', async () => {
    const repository = await createRepository()
    await writeManifest(
      repository.root,
      'fixtures/overlay.yaml',
      manifestYaml(repository.upstreamCommit, 'tracked.ts'),
    )
    await symlink('overlay.yaml', join(repository.root, 'fixtures', 'link.yaml'))

    const result = await runCli(repository.root, ['--manifest', 'fixtures/link.yaml'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('manifest path must not traverse a symlink')
  })

  it('rejects an invalid manifest without invoking Git verification', async () => {
    const repository = await createRepository()
    await writeManifest(repository.root, 'fixtures/overlay.yaml', 'schemaVersion: [\n')
    const manifestText = await readFile(join(repository.root, 'fixtures', 'overlay.yaml'), 'utf8')

    const result = await runCli(repository.root, ['--manifest', 'fixtures/overlay.yaml'])

    expect(manifestText).toContain('schemaVersion')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fixtures/overlay.yaml:')
  })
})
