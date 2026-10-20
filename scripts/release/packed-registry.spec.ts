/** Packed smoke installs cannot fall back to old published DSH packages. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { packedIdentity, packedManifest, readPublishOrder } from './tarball.ts'
import { startPackedRegistry } from './packed-registry.ts'

vi.mock('./tarball.ts', () => ({ packedIdentity: vi.fn(), packedManifest: vi.fn(), readPublishOrder: vi.fn() }))

function fixture(name = '@knyazevai/dsh'): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-registry-test-'))
  onTestFinished(() => { vi.resetAllMocks(); rmSync(directory, { recursive: true, force: true }) })
  writeFileSync(join(directory, 'cli.tgz'), 'packed CLI bytes')
  vi.mocked(readPublishOrder).mockReturnValue(['cli.tgz'])
  vi.mocked(packedIdentity).mockReturnValue({ name, version: '0.2.1' })
  vi.mocked(packedManifest).mockReturnValue({ name, version: '0.2.1', dependencies: { example: '1.0.0' } })
  return directory
}

it('serves the packed manifest and integrity-addressed bytes on an OS-assigned port', async () => {
  const registry = await startPackedRegistry(fixture())
  try {
    const result: unknown = await (await fetch(new URL('@knyazevai%2Fdsh', registry.url))).json()
    expect(result).toMatchObject({
      name: '@knyazevai/dsh', 'dist-tags': { latest: '0.2.1' },
      versions: { '0.2.1': { dependencies: { example: '1.0.0' }, dist: { tarball: `${registry.url}tarballs/cli.tgz` } } },
    })
    expect(await (await fetch(new URL('tarballs/cli.tgz', registry.url))).text()).toBe('packed CLI bytes')
    expect((await fetch(new URL('@knyazevai%2Fdsh-missing', registry.url))).status).toBe(404)
    expect((await fetch(registry.url, { method: 'POST' })).status).toBe(405)
  } finally {
    await registry.close()
  }
})

it('refuses vendor substitution and missing CLI payloads', async () => {
  await expect(startPackedRegistry(fixture('@deepseek-ai/cordis'))).rejects.toThrow('only accepts DSH')
  await expect(startPackedRegistry(fixture('@knyazevai/dsh-agent'))).rejects.toThrow('requires one CLI')
})
