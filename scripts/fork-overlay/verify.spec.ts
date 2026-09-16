import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitReader } from './git-reader.ts'
import { verifyOverlay } from './verify.ts'
import type { OverlayEntry, OverlayManifest, VerificationTarget } from './types.ts'

const execFileAsync = promisify(execFile)
const temporaryRepositories: string[] = []

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: root, encoding: 'utf8' })
  return result.stdout
}

async function createRepository(scripts: Record<string, string>): Promise<{
  readonly root: string
  readonly upstreamCommit: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-verify-'))
  temporaryRepositories.push(root)
  await runGit(root, ['init', '--quiet'])
  await runGit(root, ['config', 'user.name', 'Overlay Test'])
  await runGit(root, ['config', 'user.email', 'overlay@example.test'])
  await mkdir(join(root, 'tests'), { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'fixture', scripts }, null, 2)}\n`)
  await writeFile(join(root, 'tests', 'overlay fixture.spec.ts'), 'export {}\n')
  await writeFile(join(root, 'changed.ts'), 'before\n')
  await runGit(root, ['add', '--all'])
  await runGit(root, ['commit', '--quiet', '-m', 'initial'])
  const upstreamCommit = (await runGit(root, ['rev-parse', 'HEAD'])).trim()
  await writeFile(join(root, 'changed.ts'), 'after\n')
  return { root, upstreamCommit }
}

function makeEntry(id: string, verify: readonly VerificationTarget[]): OverlayEntry {
  return {
    id,
    kind: 'product-patch',
    paths: [{ path: 'changed.ts', coverage: 'exact' }],
    owner: 'packages/fork/fixture',
    agentNote: '.agents/notes/implemented/architecture/fixture.md',
    verify,
    retireWhen: 'upstream provides the fixture behavior',
    budget: { maxFiles: 1, maxChangedLines: 2 },
  }
}

function makeManifest(upstreamCommit: string, entries: readonly OverlayEntry[]): OverlayManifest {
  return { schemaVersion: 1, upstreamCommit, entries }
}

async function verifyFixture(
  root: string,
  manifest: OverlayManifest,
): Promise<readonly import('./types.ts').OverlayDiagnostic[]> {
  return verifyOverlay({ root, manifest, git: createGitReader(root) })
}

afterEach(async () => {
  const roots = temporaryRepositories.splice(0)
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

describe('verifyOverlay', () => {
  it('accepts a real script and Vitest target', async () => {
    const repository = await createRepository({ 'test:fixture': 'vitest run' })
    const diagnostics = await verifyFixture(repository.root, makeManifest(repository.upstreamCommit, [makeEntry(
      'valid-targets',
      [
        { kind: 'script', name: 'test:fixture' },
        { kind: 'vitest', files: ['tests/overlay fixture.spec.ts'] },
      ],
    )]))

    expect(diagnostics).toEqual([])
  })

  it('reports an upstream commit that is missing', async () => {
    const repository = await createRepository({})
    const diagnostics = await verifyFixture(repository.root, makeManifest('f'.repeat(40), []))

    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'upstream-commit-missing' }))
  })

  it('reports a script target whose package script is missing', async () => {
    const repository = await createRepository({})
    const diagnostics = await verifyFixture(repository.root, makeManifest(repository.upstreamCommit, [makeEntry(
      'missing-script',
      [{ kind: 'script', name: 'test:missing' }],
    )]))

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid-verification-target',
      entryId: 'missing-script',
    }))
  })

  it('reports a Vitest target whose file is missing', async () => {
    const repository = await createRepository({})
    const diagnostics = await verifyFixture(repository.root, makeManifest(repository.upstreamCommit, [makeEntry(
      'missing-vitest',
      [{ kind: 'vitest', files: ['tests/missing.spec.ts'] }],
    )]))

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid-verification-target',
      entryId: 'missing-vitest',
      path: 'tests/missing.spec.ts',
    }))
  })

  it('rejects a Vitest target that escapes through an ancestor symlink', async () => {
    const repository = await createRepository({})
    const outside = await mkdtemp(join(tmpdir(), 'dsh-overlay-outside-'))
    temporaryRepositories.push(outside)
    await mkdir(join(outside, 'tests'), { recursive: true })
    await writeFile(join(outside, 'tests', 'escaped.spec.ts'), 'export {}\n')
    await symlink(outside, join(repository.root, 'linked-tests'), 'dir')

    const diagnostics = await verifyFixture(repository.root, makeManifest(repository.upstreamCommit, [makeEntry(
      'ancestor-escape',
      [{ kind: 'vitest', files: ['linked-tests/tests/escaped.spec.ts'] }],
    )]))

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid-verification-target',
      entryId: 'ancestor-escape',
      path: 'linked-tests/tests/escaped.spec.ts',
    }))
  })

  it('rejects a final-component Vitest symlink even when it stays inside the root', async () => {
    const repository = await createRepository({})
    await writeFile(join(repository.root, 'tests', 'real.spec.ts'), 'export {}\n')
    await symlink('real.spec.ts', join(repository.root, 'tests', 'linked.spec.ts'), 'file')

    const diagnostics = await verifyFixture(repository.root, makeManifest(repository.upstreamCommit, [makeEntry(
      'final-symlink',
      [{ kind: 'vitest', files: ['tests/linked.spec.ts'] }],
    )]))

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid-verification-target',
      entryId: 'final-symlink',
      path: 'tests/linked.spec.ts',
    }))
  })
})
