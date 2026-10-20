/** Wait for npm's publish-time scanning and public metadata propagation before consumer installation. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { assertMainSource } from './assert-main.ts'
import { isEntry } from './process.ts'
import { packedIdentity, readPublishOrder } from './tarball.ts'

/** Immutable package identity and checksum retained from the CI pack step. */
export interface PublicReleaseMember {
  readonly name: string
  readonly version: string
  readonly integrity: string
}

interface VisibilityOptions {
  readonly timeoutMs: number
  readonly pollMs: number
  readonly beforePoll?: () => void
}

interface VisibilityClock {
  now(): number
  sleep(milliseconds: number): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function publicRequest(url: string, init: RequestInit, request: typeof fetch, requestTimeoutMs: number): Promise<Response | string> {
  let response: Response
  try { response = await request(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) }) }
  catch (error) { return `registry connection: ${String(error)}` }
  if (response.status === 404 || response.status === 408 || response.status === 429 || response.status >= 500) {
    await response.body?.cancel()
    return `registry HTTP ${String(response.status)}`
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Public npm request failed: HTTP ${String(response.status)} for ${url}`)
  }
  return response
}

/**
 * Require the full metadata, npm install metadata, and tarball to be publicly readable.
 * Missing versions, scanning delays, rate limits, and network failures remain pending; conflicting bytes fail.
 * @param member - expected immutable package version.
 * @param request - HTTP implementation, injectable without process-global interception.
 * @param requestTimeoutMs - deadline for each registry request.
 * @returns a pending reason, or undefined when both metadata views and the download are available.
 */
export async function inspectPublicPackage(
  member: PublicReleaseMember,
  request: typeof fetch = fetch,
  requestTimeoutMs = 15_000,
): Promise<string | undefined> {
  let tarball: string | undefined
  const packagePath = encodeURIComponent(member.name).replace('%40', '@').replace('%2F', '%2f')
  for (const accept of ['application/json', 'application/vnd.npm.install-v1+json']) {
    const response = await publicRequest(`https://registry.npmjs.org/${packagePath}`, { headers: { accept } }, request, requestTimeoutMs)
    if (typeof response === 'string') return `${accept}: ${response}`
    const data: unknown = await response.json()
    if (!isRecord(data) || !isRecord(data.versions)) throw new Error(`Invalid registry metadata for ${member.name}`)
    const version = data.versions[member.version]
    if (version === undefined) return `${accept}: version is not public yet`
    if (!isRecord(version) || !isRecord(version.dist) || typeof version.dist.integrity !== 'string' || typeof version.dist.tarball !== 'string') {
      throw new Error(`Invalid public version metadata for ${member.name}@${member.version}`)
    }
    if (version.dist.integrity !== member.integrity) throw new Error(`${member.name}@${member.version} has different public bytes`)
    let download: URL
    try { download = new URL(version.dist.tarball) }
    catch (error) { throw new Error(`Invalid public tarball URL for ${member.name}: ${String(error)}`) }
    if (download.protocol !== 'https:' || download.username !== '' || download.password !== '') {
      throw new Error(`Public tarball for ${member.name} requires HTTPS without embedded credentials`)
    }
    tarball = version.dist.tarball
  }
  if (tarball === undefined) throw new Error(`Public tarball URL is missing for ${member.name}`)
  const response = await publicRequest(tarball, { method: 'HEAD' }, request, requestTimeoutMs)
  if (typeof response === 'string') return `download: ${response}`
  await response.body?.cancel()
  return undefined
}

/**
 * Poll only unavailable packages; settle each admitted batch before reporting a permanent failure.
 * @param members - immutable packed release identities and checksums.
 * @param options - total visibility deadline, polling interval, and optional current-source verification.
 * @param inspect - public registry probe returning an unavailable reason or readiness.
 * @param clock - owned clock and asynchronous delay, injectable for deterministic deadline tests.
 * @returns after every package is publicly installable, or rejects with the unresolved package list.
 */
export async function waitForPublicVersions(
  members: readonly PublicReleaseMember[],
  options: VisibilityOptions,
  inspect: (member: PublicReleaseMember) => Promise<string | undefined> = inspectPublicPackage,
  clock: VisibilityClock = { now: Date.now, sleep: async (milliseconds) => { await sleep(milliseconds) } },
): Promise<void> {
  const deadline = clock.now() + options.timeoutMs
  let pending = [...members]
  let previousCount = -1
  while (pending.length > 0) {
    options.beforePoll?.()
    const unavailable: { member: PublicReleaseMember; reason: string }[] = []
    for (let offset = 0; offset < pending.length; offset += 8) {
      const results = await Promise.allSettled(pending.slice(offset, offset + 8).map(async (member) => {
        const reason = await inspect(member)
        if (reason !== undefined) unavailable.push({ member, reason })
      }))
      for (const result of results) if (result.status === 'rejected') throw result.reason
    }
    pending = unavailable.map(entry => entry.member)
    if (pending.length !== previousCount) {
      console.log(`release visibility: ${String(members.length - pending.length)}/${String(members.length)} packages publicly available`)
      previousCount = pending.length
    }
    if (pending.length === 0) return
    const details = unavailable.map(({ member, reason }) => `${member.name}@${member.version}: ${reason}`).join('\n')
    const remaining = deadline - clock.now()
    if (remaining <= 0) throw new Error(`npm publication is not publicly available before the visibility deadline:\n${details}`)
    console.log(`release visibility: waiting for npm scanning or propagation:\n${details}`)
    await clock.sleep(Math.min(options.pollMs, remaining))
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    from: { type: 'string' }, 'timeout-ms': { type: 'string', default: '3600000' },
    'poll-ms': { type: 'string', default: '15000' }, 'request-timeout-ms': { type: 'string', default: '15000' },
  } })
  if (values.from === undefined) throw new Error('usage: wait-public.ts --from <packed DSH directory> [--timeout-ms <deadline>]')
  const timeoutMs = Number(values['timeout-ms']), pollMs = Number(values['poll-ms']), requestTimeoutMs = Number(values['request-timeout-ms'])
  if (![timeoutMs, pollMs, requestTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Registry visibility deadlines and interval must be positive integers')
  assertMainSource()
  const directory = resolve(values.from)
  const members = readPublishOrder(directory).map((filename) => {
    const path = join(directory, filename)
    return { ...packedIdentity(path), integrity: `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}` }
  })
  await waitForPublicVersions(
    members, { timeoutMs, pollMs, beforePoll: assertMainSource },
    member => inspectPublicPackage(member, fetch, requestTimeoutMs),
  )
}

if (isEntry(import.meta.url)) await main()
