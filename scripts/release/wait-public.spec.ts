/** Publication succeeds before npm's public metadata and downloads necessarily become available. */
import { expect, it, vi } from 'vitest'
import { inspectPublicPackage, waitForPublicVersions, type PublicReleaseMember } from './wait-public.ts'

const member: PublicReleaseMember = { name: '@knyazevai/dsh-sdk-app', version: '0.2.1', integrity: 'sha512-expected' }
const metadata = { versions: { '0.2.1': { dist: { integrity: member.integrity, tarball: 'https://registry.npmjs.org/example.tgz' } } } }

function clock() {
  let now = 0
  return { now: () => now, sleep: vi.fn(async (milliseconds: number) => { now += milliseconds }) }
}

it('waits for both metadata views and the download, rather than trusting publish success', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(new Response('', { status: 404 }))
  expect(await inspectPublicPackage(member, request)).toContain('404')
  request.mockReset()
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(new Response(null))
  expect(await inspectPublicPackage(member, request)).toBeUndefined()
  expect(request.mock.calls.map(([, options]) => options?.headers)).toEqual([
    { accept: 'application/json' }, { accept: 'application/vnd.npm.install-v1+json' }, undefined,
  ])
  expect(request.mock.calls[2]?.[1]?.method).toBe('HEAD')
  expect(request.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/@knyazevai%2fdsh-sdk-app')
})

it.each([404, 429, 503])('reports temporary registry HTTP %s as pending', async (status) => {
  expect(await inspectPublicPackage(member, vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status })))).toContain(String(status))
})

it('waits when only the tarball is unavailable', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(new Response('', { status: 404 }))
  expect(await inspectPublicPackage(member, request)).toContain('download')
})

it('waits when an existing package still exposes only its previous version', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ versions: { '0.1.5': {} } }))
  expect(await inspectPublicPackage(member, request)).toContain('version is not public yet')
})

it('reports a temporary registry connection failure as pending', async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection closed'))
  expect(await inspectPublicPackage(member, request)).toContain('registry connection')
})

it('refuses conflicting public bytes instead of retrying', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ versions: { '0.2.1': { dist: { ...metadata.versions['0.2.1'].dist, integrity: 'sha512-other' } } } }))
  await expect(inspectPublicPackage(member, request)).rejects.toThrow('different public bytes')
})

it('does not hide registry authorization or malformed metadata failures', async () => {
  await expect(inspectPublicPackage(member, vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 })))).rejects.toThrow('403')
  await expect(inspectPublicPackage(member, vi.fn<typeof fetch>().mockResolvedValue(Response.json({ versions: [] })))).rejects.toThrow('Invalid registry metadata')
})

it.each(['not-a-url', 'http://localhost/archive.tgz', 'https://name:secret@example.com/archive.tgz'])('refuses invalid download URL %s', async (tarball) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ versions: { '0.2.1': { dist: { ...metadata.versions['0.2.1'].dist, tarball } } } }))
  await expect(inspectPublicPackage(member, request)).rejects.toThrow(/tarball.*(?:URL|HTTPS)/u)
  expect(request).toHaveBeenCalledTimes(1)
})

it('polls pending packages until their public views agree', async () => {
  const time = clock()
  const inspect = vi.fn().mockResolvedValueOnce('npm metadata HTTP 404').mockResolvedValueOnce(undefined)
  await waitForPublicVersions([member], { timeoutMs: 100, pollMs: 10 }, inspect, time)
  expect(inspect).toHaveBeenCalledTimes(2)
  expect(time.sleep).toHaveBeenCalledWith(10)
})

it('reports the missing package when the registry visibility deadline expires', async () => {
  const time = clock()
  await expect(waitForPublicVersions([member], { timeoutMs: 20, pollMs: 10 }, async () => 'npm metadata HTTP 404', time)).rejects.toThrow('@knyazevai/dsh-sdk-app@0.2.1')
  expect(time.sleep).toHaveBeenCalledTimes(2)
})

it('stops polling when current-source verification refuses the release', async () => {
  const inspect = vi.fn()
  const beforePoll = () => { throw new Error('Remote main moved') }
  await expect(waitForPublicVersions([member], { timeoutMs: 100, pollMs: 10, beforePoll }, inspect, clock())).rejects.toThrow('Remote main moved')
  expect(inspect).not.toHaveBeenCalled()
})

it('settles admitted probes before propagating a permanent failure', async () => {
  const admitted = Promise.withResolvers<undefined>()
  let settled = false
  const inspect = vi.fn().mockRejectedValueOnce(new Error('conflict')).mockImplementationOnce(async () => { await admitted.promise; settled = true })
  const waiting = waitForPublicVersions([member, { ...member, name: '@knyazevai/dsh' }], { timeoutMs: 100, pollMs: 10 }, inspect, clock())
  const rejected = expect(waiting).rejects.toThrow('conflict')
  expect(settled).toBe(false)
  admitted.resolve(undefined)
  await rejected
  expect(settled).toBe(true)
})
