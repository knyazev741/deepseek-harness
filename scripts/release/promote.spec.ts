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
  const latest = new Map(names.map(name => [name, '0.1.5']))
  const setLatest = vi.fn<PromotionRegistry['setLatest']>().mockImplementation(async (name, version) => { latest.set(name, version) })
  const read = vi.fn<PromotionRegistry['read']>().mockImplementation(async name => ({ integrity: integrities[names.indexOf(name)]!, latest: latest.get(name)! }))
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

it('waits for cached tags to update without repeating registry writes', async () => {
  const { directory, registry, names } = fixture()
  const baseline = registry.read.getMockImplementation()
  if (baseline === undefined) throw new Error('Fixture has no registry reader')
  let remaining = 3
  registry.read.mockImplementation(async (name, version) => {
    const result = await baseline(name, version)
    return name === names[0] && registry.setLatest.mock.calls.some(([written]) => written === name) && remaining-- > 0
      ? { ...result, latest: '0.1.5' } : result
  })
  let now = 0
  await promoteRelease(directory, registry, { timeoutMs: 10, pollMs: 2 }, { now: () => now, sleep: async (ms) => { now += ms } })
  expect(now).toBe(6)
  expect(registry.setLatest.mock.calls).toEqual([[names[1], '0.2.1'], [names[0], '0.2.1']])
})

it('reports a tag propagation deadline and stops before changing the CLI', async () => {
  const { directory, registry, integrities } = fixture()
  registry.read.mockImplementation(async name => ({ integrity: integrities[name === '@knyazevai/dsh' ? 0 : 1]!, latest: '0.1.5' }))
  let now = 0
  await expect(promoteRelease(directory, registry, { timeoutMs: 3, pollMs: 1 }, { now: () => now, sleep: async (ms) => { now += ms } }))
    .rejects.toThrow('latest still names 0.1.5')
  expect(now).toBe(3)
  expect(registry.setLatest.mock.calls).toEqual([['@knyazevai/dsh-agent', '0.2.1']])
})

it.each(['mismatch', 'newer'] as const)('stops immediately on %s metadata after a tag write', async (kind) => {
  const { directory, registry } = fixture()
  const baseline = registry.read.getMockImplementation()
  if (baseline === undefined) throw new Error('Fixture has no registry reader')
  registry.read.mockImplementation(async (name, version) => {
    const result = await baseline(name, version)
    if (registry.setLatest.mock.calls.length === 0) return result
    return kind === 'mismatch' ? { ...result, integrity: 'different' } : { ...result, latest: '0.3.0' }
  })
  await expect(promoteRelease(directory, registry)).rejects.toThrow(kind === 'mismatch' ? 'different public bytes' : 'newer')
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
