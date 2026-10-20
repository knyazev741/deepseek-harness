/** Promote verified public tarballs to latest, with the npx entry updated last. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gt, prerelease, valid } from 'semver'
import { assertMainSource } from './assert-main.ts'
import { capture, isEntry } from './process.ts'
import { packedIdentity, readPublishOrder } from './tarball.ts'
import { waitForPublicVersions } from './wait-public.ts'

interface RegistryVersion {
  readonly integrity: string
  readonly latest?: string
}

interface PromotionOptions {
  readonly skipCli?: boolean
  readonly timeoutMs?: number
  readonly pollMs?: number
}

type PromotionClock = NonNullable<Parameters<typeof waitForPublicVersions>[3]>

/** npm operations supplied separately so preflight refusal can be verified without registry writes. */
export interface PromotionRegistry {
  read(name: string, version: string): Promise<RegistryVersion>
  /**
   * Request a latest-tag update; public reads may still return its previous value.
   * @param name - Package whose tag to update.
   * @param version - Exact verified version to select.
   * @returns After the registry accepts the write.
   */
  setLatest(name: string, version: string): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const publicRegistry: PromotionRegistry = {
  async read(name, version) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Cannot inspect ${name}: registry HTTP ${String(response.status)}`)
    const data: unknown = await response.json()
    if (!isRecord(data) || !isRecord(data.versions) || !isRecord(data['dist-tags'])) throw new Error(`Invalid registry metadata for ${name}`)
    const selected = data.versions[version]
    if (!isRecord(selected) || !isRecord(selected.dist) || typeof selected.dist.integrity !== 'string') throw new Error(`${name}@${version} has no public tarball integrity`)
    const latest = data['dist-tags'].latest
    if (latest !== undefined && (typeof latest !== 'string' || valid(latest) !== latest)) throw new Error(`${name} has an invalid latest tag`)
    return { integrity: selected.dist.integrity, ...latest === undefined ? {} : { latest } }
  },
  setLatest(name, version) {
    capture('npm', ['dist-tag', 'add', `${name}@${version}`, 'latest'])
    return Promise.resolve()
  },
}

/**
 * Verify uploaded artifacts before changing tags; a modular publisher can leave the CLI untouched.
 * @param directory - immutable tarballs retained from the successful pack job.
 * @param registry - public npm reader and writer, or an owned test implementation.
 * @param options - Modular-only ownership and the deadline and interval for public tag propagation.
 * @param clock - Owned clock and delay for deterministic propagation checks.
 * @returns After every selected package's latest tag has been verified at its packed version.
 */
export async function promoteRelease(
  directory: string, registry: PromotionRegistry = publicRegistry, options: PromotionOptions = {}, clock?: PromotionClock,
): Promise<void> {
  const members = readPublishOrder(directory).map((filename) => {
    const path = join(directory, filename)
    return { ...packedIdentity(path), integrity: `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}` }
  })
  const cli = members.find(member => member.name === '@knyazevai/dsh')
  if (cli === undefined || valid(cli.version) !== cli.version || prerelease(cli.version) !== null) throw new Error('Promotion requires one stable DSH CLI release')
  if (new Set(members.map(member => member.name)).size !== members.length) throw new Error('Promotion contains duplicate package names')
  for (const member of members) {
    if (member.version !== cli.version || (member.name !== cli.name && !member.name.startsWith('@knyazevai/dsh-'))) {
      throw new Error('Promotion requires one exact DSH family version')
    }
  }
  for (let offset = 0; offset < members.length; offset += 8) {
    const results = await Promise.allSettled(members.slice(offset, offset + 8).map(async (member) => {
      const remote = await registry.read(member.name, member.version)
      if (remote.integrity !== member.integrity) throw new Error(`${member.name}@${member.version} has different public bytes`)
      if (remote.latest !== undefined && gt(remote.latest, member.version)) throw new Error(`${member.name}@latest already names newer ${remote.latest}`)
    }))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  const promoted = [...members.filter(member => member !== cli), ...options.skipCli === true ? [] : [cli]]
  for (const member of promoted) {
    await registry.setLatest(member.name, member.version)
    await waitForPublicVersions([member], { timeoutMs: options.timeoutMs ?? 120_000, pollMs: options.pollMs ?? 2000 }, async (expected) => {
      const remote = await registry.read(expected.name, expected.version)
      if (remote.integrity !== expected.integrity) throw new Error(`${expected.name}@${expected.version} has different public bytes`)
      if (remote.latest !== undefined && gt(remote.latest, expected.version)) throw new Error(`${expected.name}@latest already names newer ${remote.latest}`)
      return remote.latest === expected.version ? undefined : `latest still names ${remote.latest ?? '(unset)'}`
    }, clock)
    console.log(`release promote: ${member.name}@latest = ${member.version}`)
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    from: { type: 'string' }, 'skip-cli': { type: 'boolean' },
    'tag-timeout-ms': { type: 'string', default: '120000' }, 'tag-poll-ms': { type: 'string', default: '2000' },
  } })
  if (values.from === undefined) throw new Error('usage: promote.ts --from <packed DSH directory> [--skip-cli]')
  const timeoutMs = Number(values['tag-timeout-ms']), pollMs = Number(values['tag-poll-ms'])
  if (![timeoutMs, pollMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Tag deadlines and interval must be positive integers')
  assertMainSource()
  await promoteRelease(resolve(values.from), publicRegistry, { skipCli: values['skip-cli'] === true, timeoutMs, pollMs })
}

if (isEntry(import.meta.url)) await main()
