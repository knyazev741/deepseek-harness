/** Select a fresh stable version for the main-branch npm publication. */
import { readFileSync } from 'node:fs'
import { inc, prerelease, rcompare, valid } from 'semver'
import { attempt, capture, isEntry } from './process.ts'

/**
 * Reserve a stable version above every published CLI version and the source baseline.
 * @param current - repository version, including an upstream prerelease baseline.
 * @param published - versions already reserved in the public registry, on any channel.
 * @returns the unused stable release number, or the next patch after a stable baseline.
 */
export function nextMainVersion(current: string, published: readonly string[]): string {
  const versions = [current, ...published]
  for (const version of versions) {
    if (valid(version) !== version) throw new Error(`Invalid release version ${JSON.stringify(version)}`)
  }
  const highest = versions.toSorted(rcompare)[0]
  if (highest === undefined) throw new Error('Release baseline is missing')
  const result = prerelease(highest) === null ? inc(highest, 'patch') : highest.split('-')[0]
  if (result === null || result === undefined) throw new Error(`Cannot advance ${highest}`)
  return result
}

function main(): void {
  const source: unknown = JSON.parse(readFileSync('package.json', 'utf8'))
  if (source === null || typeof source !== 'object' || !('version' in source) || typeof source.version !== 'string') {
    throw new Error('Repository package.json has no version')
  }
  const result = attempt('npm', ['view', '@knyazevai/dsh', 'versions', '--json'])
  if (result.status !== 0) throw new Error(`Cannot read published CLI versions: ${result.stderr}`)
  const data: unknown = JSON.parse(result.stdout)
  const versions: unknown[] = Array.isArray(data) ? data : [data]
  if (!versions.every((version): version is string => typeof version === 'string')) {
    throw new Error('Registry versions must be strings')
  }
  const tagged = capture('git', ['tag', '--list', 'dsh-v*']).split(/\r?\n/u).filter(tag => tag !== '').map(tag => tag.slice('dsh-v'.length))
  console.log(nextMainVersion(source.version, [...versions, ...tagged]))
}

if (isEntry(import.meta.url)) main()
