/** The npm entry includes its runtime plugins without fetching sibling package versions. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as createTar } from 'tar'
import { expect, it, onTestFinished } from 'vitest'
import { removeFixtureSafely } from '../test-fixture-cleanup.ts'
import { planEntry, packEntry } from './pack-entry.ts'
import { packedManifest, PUBLISH_ORDER_FILE, readPublishOrder, tarballFiles } from './tarball.ts'

const cli = '@knyazevai/dsh'
const implementation = '@knyazevai/dsh-implementation'
const service = '@knyazevai/dsh-service'
const version = '1.2.3'
const framework = '@deepseek-ai/cordis'
const foundation = '@deepseek-ai/cosmokit'
const vendorManifests = [
  { name: framework, version: '4.0.0', dependencies: { [foundation]: '^1.0.0' } },
  { name: foundation, version: '1.5.0' },
]

function manifests() {
  return [
    { name: cli, version, dependencies: { [implementation]: version, yaml: '^2.4.2' }, devDependencies: { [service]: version } },
    { name: implementation, version, peerDependencies: { [service]: version }, dependencies: { yaml: '^2.9.0', zod: '^4.4.3' } },
    { name: service, version, dependencies: { zod: '4.4.3' }, peerDependencies: { unused: '*' }, peerDependenciesMeta: { unused: { optional: true } } },
    { name: '@knyazevai/dsh-sdk-client', version, dependencies: { [cli]: version } },
  ]
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-entry-'))
  onTestFinished(() => { removeFixtureSafely(root) })
  const source = join(root, 'thin'), destination = join(root, 'entry')
  mkdirSync(source)
  const names: string[] = []
  for (const [index, manifest] of manifests().entries()) {
    const directory = join(root, String(index))
    mkdirSync(join(directory, 'package', 'lib'), { recursive: true })
    writeFileSync(join(directory, 'package', 'lib', 'index.js'), 'export const fixture = true;\n')
    if (manifest.name === cli) {
      mkdirSync(join(directory, 'package', 'docs', 'upgrade-guide'), { recursive: true })
      mkdirSync(join(directory, 'package', 'src'))
      writeFileSync(join(directory, 'package', 'docs', 'upgrade-guide', 'README.md'), '# Upgrade guide\n')
      writeFileSync(join(directory, 'package', 'src', 'bin.ts'), 'export const fixture = true;\n')
    }
    writeFileSync(join(directory, 'package', 'package.json'), JSON.stringify({
      ...manifest, files: manifest.name === cli ? ['lib', 'docs', 'src'] : ['lib'],
      scripts: { prepack: 'node missing-hook.cjs', prepare: 'node missing-hook.cjs' },
    }))
    const filename = `${manifest.name.slice(1).replace('/', '-')}-${version}.tgz`
    createTar({ file: join(source, filename), cwd: directory, sync: true, gzip: true }, ['package'])
    names.push(filename)
  }
  writeFileSync(join(source, PUBLISH_ORDER_FILE), `${names.join('\n')}\n`)
  return { root, source, destination, names }
}

it('includes runtime peers, excludes development consumers, and lifts compatible external requirements', () => {
  const plan = planEntry(manifests())
  expect(plan.bundled).toEqual([implementation, service])
  expect(plan.manifest.dependencies).toEqual({ [implementation]: version, [service]: version, yaml: '^2.9.0', zod: '4.4.3' })
  expect(plan.manifest.bundleDependencies).toEqual([implementation, service])
  expect(plan.manifest).not.toHaveProperty('devDependencies')
  expect(plan.manifest.dependencies).not.toHaveProperty('unused')
})

it('bundles the source framework and its dependencies at their independent exact versions', () => {
  const selected = manifests().map(manifest => manifest.name === service ? {
    ...manifest, peerDependencies: { [framework]: '^4.0.0' },
  } : manifest)
  const plan = planEntry(selected, vendorManifests)
  expect(plan.bundled).toEqual([framework, foundation, implementation, service])
  expect(plan.manifest.dependencies).toMatchObject({ [framework]: '4.0.0', [foundation]: '1.5.0' })
  expect(() => planEntry(selected, vendorManifests.map(manifest => ({ ...manifest, version: '3.0.0' })))).toThrow('incompatible')
})

it('preserves optional external dependencies and install hooks while removing packing hooks', () => {
  const selected = manifests().map(manifest => manifest.name === cli ? {
    ...manifest, optionalDependencies: { 'platform-addon': '^1.0.0' },
    scripts: { prepack: 'build', prepare: 'build', postpack: 'cleanup', postinstall: 'install-helper' },
  } : manifest)
  const { manifest } = planEntry(selected)
  expect(manifest.optionalDependencies).toEqual({ 'platform-addon': '^1.0.0' })
  expect(manifest.scripts).toEqual({ postinstall: 'install-helper' })
})

it.each([
  { name: 'missing runtime peer', change: () => manifests().filter(manifest => manifest.name !== service), error: 'Missing runtime package' },
  { name: 'conflicting external ranges', change: () => [...manifests(), { name: '@knyazevai/dsh-extra', version }].map(manifest => manifest.name === service ? { ...manifest, dependencies: { yaml: '^1.0.0' } } : manifest), error: 'incompatible yaml' },
  { name: 'mixed versions', change: () => manifests().map(manifest => manifest.name === service ? { ...manifest, version: '1.2.4' } : manifest), error: 'one exact DSH version' },
])('refuses $name before packing', ({ change, error }) => {
  expect(() => planEntry(change())).toThrow(error)
})

it('packs every runtime file, including a production peer also declared as a root dev dependency, without hooks', () => {
  const { source, destination, names } = fixture()
  const library = readFileSync(join(source, names[1]!))
  const filename = packEntry(source, destination)
  expect(readPublishOrder(destination)).toEqual([filename])
  const archive = join(destination, filename)
  const files = tarballFiles(archive)
  expect(files).toContain('package/docs/upgrade-guide/README.md')
  expect(files).toContain('package/src/bin.ts')
  for (const name of [implementation, service]) {
    expect(files).toContain(`package/node_modules/${name}/package.json`)
    expect(files).toContain(`package/node_modules/${name}/lib/index.js`)
  }
  expect(files.some(file => file.includes('dsh-sdk-client'))).toBe(false)
  expect(files.some(file => file.includes('node_modules/yaml/'))).toBe(false)
  expect(packedManifest(archive)).not.toHaveProperty('devDependencies')
  expect(readFileSync(join(source, filename))).toEqual(readFileSync(archive))
  expect(readFileSync(join(source, names[1]!))).toEqual(library)
}, 30_000)

it('carries the built framework inside the CLI without publishing a separate framework package', () => {
  const { root, source, destination, names } = fixture()
  const vendor = join(root, 'vendor')
  mkdirSync(vendor)
  const vendorNames: string[] = []
  for (const [index, manifest] of vendorManifests.entries()) {
    const directory = join(root, `vendor-${String(index)}`)
    mkdirSync(join(directory, 'package', 'lib'), { recursive: true })
    writeFileSync(join(directory, 'package', 'lib', 'index.js'), 'export const sourceFramework = true;\n')
    writeFileSync(join(directory, 'package', 'package.json'), JSON.stringify({ ...manifest, files: ['lib'] }))
    const filename = `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`
    createTar({ file: join(vendor, filename), cwd: directory, sync: true, gzip: true }, ['package'])
    vendorNames.push(filename)
  }
  writeFileSync(join(vendor, PUBLISH_ORDER_FILE), `${vendorNames.join('\n')}\n`)
  const serviceDirectory = join(root, '2')
  const serviceManifest = JSON.parse(readFileSync(join(serviceDirectory, 'package', 'package.json'), 'utf8')) as Record<string, unknown>
  writeFileSync(join(serviceDirectory, 'package', 'package.json'), JSON.stringify({ ...serviceManifest, peerDependencies: { [framework]: '^4.0.0' } }))
  createTar({ file: join(source, names[2]!), cwd: serviceDirectory, sync: true, gzip: true }, ['package'])
  const filename = packEntry(source, destination, vendor)
  expect(readPublishOrder(destination)).toEqual([filename])
  const archive = join(destination, filename)
  for (const name of [framework, foundation]) expect(tarballFiles(archive)).toContain(`package/node_modules/${name}/lib/index.js`)
  expect(packedManifest(archive).dependencies).toMatchObject({ [framework]: '4.0.0', [foundation]: '1.5.0' })
}, 30_000)
