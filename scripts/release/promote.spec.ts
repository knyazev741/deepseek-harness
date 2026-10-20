/** Latest cannot expose a partial, unverified, or older CLI release. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { promoteRelease, type PromotionRegistry } from './promote.ts'
import { packedIdentity, readPublishOrder } from './tarball.ts'

vi.mock('./tarball.ts', () => ({ packedIdentity: vi.fn(), readPublishOrder: vi.fn() }))

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-promote-test-'))
  onTestFinished(() => { vi.resetAllMocks(); rmSync(directory, { recursive: true, force: true }) })
  const names = ['@knyazevai/dsh', '@knyazevai/dsh-agent']
  const integrities = names.map((name, index) => {
    const bytes = Buffer.from(name)
    writeFileSync(join(directory, `${String(index)}.tgz`), bytes)
    return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  })
  vi.mocked(readPublishOrder).mockReturnValue(['0.tgz', '1.tgz'])
  vi.mocked(packedIdentity).mockImplementation(path => ({ name: path.endsWith('0.tgz') ? names[0]! : names[1]!, version: '0.2.1' }))
  const setLatest = vi.fn<PromotionRegistry['setLatest']>().mockResolvedValue(undefined)
  const read = vi.fn<PromotionRegistry['read']>().mockImplementation(async name => ({ integrity: integrities[names.indexOf(name)]!, latest: '0.1.5' }))
  return { directory, names, integrities, registry: { read, setLatest } }
}

it('promotes the CLI last even when its tarball is first', async () => {
  const { directory, registry } = fixture()
  await promoteRelease(directory, registry)
  expect(registry.setLatest.mock.calls).toEqual([['@knyazevai/dsh-agent', '0.2.1'], ['@knyazevai/dsh', '0.2.1']])
})

it('leaves the CLI tag untouched during a separate modular publication', async () => {
  const { directory, registry } = fixture()
  await promoteRelease(directory, registry, { skipCli: true })
  expect(registry.setLatest.mock.calls).toEqual([['@knyazevai/dsh-agent', '0.2.1']])
})

it.each(['mismatch', 'missing', 'newer'] as const)('makes no tag writes when preflight finds %s', async (kind) => {
  const { directory, registry, integrities } = fixture()
  registry.read.mockImplementation(async (name) => {
    if (kind === 'missing') throw new Error('Missing registry version')
    return { integrity: kind === 'mismatch' ? 'different' : integrities[name === '@knyazevai/dsh' ? 0 : 1]!, latest: kind === 'newer' ? '0.3.0' : '0.1.5' }
  })
  await expect(promoteRelease(directory, registry)).rejects.toThrow(kind === 'missing' ? 'Missing registry' : kind === 'mismatch' ? 'different public bytes' : 'newer')
  expect(registry.setLatest).not.toHaveBeenCalled()
})

it('keeps the CLI tag unchanged when another package promotion fails', async () => {
  const { directory, registry } = fixture()
  registry.setLatest.mockRejectedValueOnce(new Error('Registry write refused'))
  await expect(promoteRelease(directory, registry)).rejects.toThrow('Registry write refused')
  expect(registry.setLatest.mock.calls).toEqual([['@knyazevai/dsh-agent', '0.2.1']])
})

it.each(['0.2.1-rc.1', 'latest'])('refuses a nonstable CLI version %s before any registry access', async (version) => {
  const { directory, registry } = fixture()
  vi.mocked(packedIdentity).mockReturnValue({ name: '@knyazevai/dsh', version })
  await expect(promoteRelease(directory, registry)).rejects.toThrow('stable DSH CLI')
  expect(registry.read).not.toHaveBeenCalled()
})
