/** The npm entry includes its runtime plugins without fetching sibling package versions. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { removeFixtureSafely } from '../test-fixture-cleanup.ts'
import { planEntry, packEntry } from './pack-entry.ts'
import { capture } from './process.ts'
import { packedManifest, PUBLISH_ORDER_FILE, readPublishOrder, tarballFiles } from './tarball.ts'

const cli = '@knyazevai/dsh'
const implementation = '@knyazevai/dsh-implementation'
const service = '@knyazevai/dsh-service'
const version = '1.2.3'

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
    writeFileSync(join(directory, 'package', 'package.json'), JSON.stringify({
      ...manifest, files: ['lib'], scripts: { prepack: 'node missing-hook.cjs', prepare: 'node missing-hook.cjs' },
    }))
    const filename = `${manifest.name.slice(1).replace('/', '-')}-${version}.tgz`
    capture('tar', ['-czf', filename, '-C', directory, 'package'], { cwd: source })
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
