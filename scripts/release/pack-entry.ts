/** Bundle the CLI's own runtime packages so its installation needs one DSH tarball. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { subset, valid, validRange } from 'semver'
import { validateTarballPayload } from '../publication-payload.ts'
import { tarballName } from './families.ts'
import { npmCliPath } from './npm.ts'
import { capture, isEntry } from './process.ts'
import { packedManifest, PUBLISH_ORDER_FILE, readPublishOrder, tarballFiles } from './tarball.ts'

const CLI = '@knyazevai/dsh'
const ownPackage = (name: string): boolean => name === CLI || /^@knyazevai\/dsh-[a-z0-9-]+$/u.test(name)
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Production CLI manifest and the exact sibling packages carried in its archive. */
export interface EntryPlan {
  readonly version: string
  readonly manifest: Record<string, unknown>
  readonly bundled: readonly string[]
}

function dependencies(manifest: Record<string, unknown>, section: string): Record<string, string> {
  const value = manifest[section]
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${String(manifest.name)} has invalid ${section}`)
  const result: Record<string, string> = {}
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec !== 'string') throw new Error(`${String(manifest.name)} has invalid ${section}.${name}`)
    result[name] = spec
  }
  return result
}

function runtimeDependencies(manifest: Record<string, unknown>): { name: string; spec: string; optional: boolean }[] {
  const optional = dependencies(manifest, 'optionalDependencies')
  const peers = manifest.peerDependenciesMeta
  if (peers !== undefined && !isRecord(peers)) throw new Error(`${String(manifest.name)} has invalid peerDependenciesMeta`)
  return [
    ...Object.entries(dependencies(manifest, 'dependencies')).filter(([name]) => !(name in optional)).map(([name, spec]) => ({ name, spec, optional: false })),
    ...Object.entries(optional).map(([name, spec]) => ({ name, spec, optional: true })),
    ...Object.entries(dependencies(manifest, 'peerDependencies')).filter(([name]) => {
      const metadata = peers?.[name]
      return !isRecord(metadata) || metadata.optional !== true
    }).map(([name, spec]) => ({ name, spec, optional: false })),
  ]
}

/**
 * Select declared runtime dependencies and required peers; lift foreign ranges for npm's normal resolver.
 * @param manifests - Thin, validated DSH family manifests from one release.
 * @returns A production manifest and its sibling package closure; incompatible ranges fail before packing.
 */
export function planEntry(manifests: readonly Record<string, unknown>[]): EntryPlan {
  const source = new Map<string, Record<string, unknown>>()
  const entry = manifests.find(manifest => manifest.name === CLI)
  if (entry === undefined || typeof entry.version !== 'string' || valid(entry.version) !== entry.version) throw new Error('Entry pack requires a versioned DSH CLI')
  const version = entry.version
  for (const manifest of manifests) {
    if (typeof manifest.name !== 'string' || !ownPackage(manifest.name) || manifest.version !== version) throw new Error('Entry pack requires one exact DSH version')
    if (source.has(manifest.name)) throw new Error(`Duplicate runtime package ${manifest.name}`)
    source.set(manifest.name, manifest)
  }
  if (entry.bundleDependencies !== undefined || entry.bundledDependencies !== undefined) throw new Error('Entry pack requires thin input tarballs')
  const selected = new Set([CLI])
  const external = new Map<string, { specs: Set<string>; optional: boolean }>()
  for (const name of selected) {
    const manifest = source.get(name)
    if (manifest === undefined) throw new Error(`Missing runtime package ${name}`)
    for (const dependency of runtimeDependencies(manifest)) {
      if (ownPackage(dependency.name)) {
        if (dependency.spec !== version) throw new Error(`${name} must declare ${dependency.name} at exact ${version}`)
        selected.add(dependency.name)
      } else {
        const constraint = external.get(dependency.name) ?? { specs: new Set<string>(), optional: true }
        constraint.specs.add(dependency.spec)
        constraint.optional &&= dependency.optional
        external.set(dependency.name, constraint)
      }
    }
  }
  const bundled = [...selected].filter(name => name !== CLI).sort()
  const required = Object.fromEntries(bundled.map(name => [name, version]))
  const optional: Record<string, string> = {}
  for (const [name, constraint] of [...external].sort(([a], [b]) => a.localeCompare(b))) {
    const specs = [...constraint.specs].sort()
    const range = specs.find(candidate => validRange(candidate) !== null
      && specs.every(other => validRange(other) !== null && subset(candidate, other)))
    if (range === undefined) throw new Error(`Entry pack has incompatible ${name} requirements: ${specs.join(', ')}`)
    ;(constraint.optional ? optional : required)[name] = range
  }
  const manifest: Record<string, unknown> = { ...entry, dependencies: required, bundleDependencies: bundled }
  // npm pack omits bundles also listed in root devDependencies, even when they are production dependencies.
  delete manifest.devDependencies
  delete manifest.optionalDependencies
  if (Object.keys(optional).length > 0) manifest.optionalDependencies = optional
  if (manifest.scripts !== undefined) {
    if (!isRecord(manifest.scripts)) throw new Error('CLI scripts must be an object')
    manifest.scripts = Object.fromEntries(Object.entries(manifest.scripts).filter(([name]) => !['prepack', 'prepare', 'postpack'].includes(name)))
  }
  return { version, manifest, bundled }
}

/**
 * Pack one self-contained DSH entry and replace the family's CLI with those same immutable bytes.
 * @param source - Validated thin family tarballs and their publish order.
 * @param destination - New output directory for the entry-only publish order.
 * @returns The CLI tarball filename, after every original runtime file is verified in the new archive.
 */
export function packEntry(source: string, destination: string): string {
  if (existsSync(destination)) throw new Error(`Entry output already exists: ${destination}`)
  const archives = new Map<string, { path: string; files: string[]; manifest: Record<string, unknown> }>()
  for (const filename of readPublishOrder(source)) {
    if (basename(filename) !== filename || !filename.endsWith('.tgz')) throw new Error(`Invalid packed filename ${filename}`)
    const path = join(source, filename), manifest = packedManifest(path), files = tarballFiles(path)
    if (typeof manifest.name !== 'string' || archives.has(manifest.name)) throw new Error(`Invalid or duplicate packed identity ${filename}`)
    for (const file of files) {
      if (!file.startsWith('package/') || file.split('/').includes('..') || file.startsWith('package/node_modules/')) throw new Error(`Entry input contains unexpected member ${file}`)
    }
    validateTarballPayload(files, manifest.name)
    archives.set(manifest.name, { path, files, manifest })
  }
  const plan = planEntry([...archives.values()].map(archive => archive.manifest))
  const entryArchive = archives.get(CLI)
  if (entryArchive === undefined) throw new Error('Entry pack requires a DSH CLI tarball')
  const filename = tarballName({ name: CLI, version: plan.version })
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-entry-'))
  try {
    const staging = join(root, 'package'), output = join(root, 'output'), expected: string[] = []
    mkdirSync(output)
    for (const name of [CLI, ...plan.bundled]) {
      const archive = archives.get(name)
      if (archive === undefined) throw new Error(`Missing runtime package ${name}`)
      const target = name === CLI ? staging : join(staging, 'node_modules', name)
      mkdirSync(target, { recursive: true })
      capture('tar', ['-xzf', basename(archive.path), '--strip-components=1', '-C', target], { cwd: dirname(archive.path) })
      expected.push(...archive.files.filter(file => !file.endsWith('/')).map(file => name === CLI ? file : `package/node_modules/${name}/${file.slice('package/'.length)}`))
    }
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`)
    writeFileSync(join(root, '.npmrc'), '')
    writeFileSync(join(root, 'global.npmrc'), '')
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL'].includes(name)))
    capture(process.execPath, [npmCliPath(), 'pack', '--ignore-scripts', '--offline', '--loglevel=error', '--pack-destination', output], {
      cwd: staging, env: { ...inherited, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
        npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, '.npmrc'), npm_config_globalconfig: join(root, 'global.npmrc') },
    })
    const packed = join(output, filename), files = tarballFiles(packed), actual = new Set(files)
    validateTarballPayload(files, CLI)
    for (const file of expected) if (!actual.has(file)) throw new Error(`Entry archive omitted runtime file ${file}`)
    mkdirSync(destination, { recursive: true })
    copyFileSync(packed, join(destination, filename))
    copyFileSync(packed, entryArchive.path)
    writeFileSync(join(destination, PUBLISH_ORDER_FILE), `${filename}\n`)
    console.log(`release entry pack: ${String(plan.bundled.length)} bundled DSH runtime packages in ${filename}`)
    return filename
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function main(): void {
  const { values } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' } } })
  if (values.from === undefined || values.out === undefined) throw new Error('usage: pack-entry.ts --from <thin family directory> --out <new entry directory>')
  packEntry(resolve(values.from), resolve(values.out))
}

if (isEntry(import.meta.url)) main()
