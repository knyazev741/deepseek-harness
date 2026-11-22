/**
 * Reading packed npm tarballs and the order file that accompanies them.
 *
 * The release steps after pack treat a directory of tarballs as the unit of
 * work, so they read what a tarball declares rather than what the checkout
 * currently says.
 */

import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { list } from 'tar'
import { capture } from './process.ts'

/** Name of the file recording the order in which a packed family uploads. */
export const PUBLISH_ORDER_FILE = 'publish-order.txt'

/** What a packed tarball calls itself. */
export interface PackedIdentity {
  /** Package name from the packed manifest. */
  readonly name: string
  /** Package version from the packed manifest. */
  readonly version: string
}

/**
 * List every tarball member without a subprocess output-size limit; reject invalid archives.
 * @param tarball - absolute tarball path.
 * @returns Every path inside the archive.
 */
export function tarballFiles(tarball: string): string[] {
  const files: string[] = []
  list({ file: tarball, sync: true, strict: true, onReadEntry: (entry) => { files.push(entry.path) } })
  return files
}

/**
 * Read the manifest contained in a packed tarball, without consulting the checkout.
 * @param tarball - Absolute tarball path.
 * @returns The packed package.json object.
 */
export function packedManifest(tarball: string): Record<string, unknown> {
  const manifest: unknown = JSON.parse(capture('tar', ['-xOzf', basename(tarball), 'package/package.json'], { cwd: dirname(tarball) }))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`${tarball} has no manifest`)
  return manifest as Record<string, unknown>
}

/**
 * Read a packed tarball's own identity.
 * @param tarball - Absolute tarball path.
 * @returns The name and version the tarball declares.
 */
export function packedIdentity(tarball: string): PackedIdentity {
  const { name, version } = packedManifest(tarball)
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error(`${tarball} manifest lacks name/version`)
  return { name, version }
}

/**
 * Read a packed directory's upload order.
 * @param directory - absolute path of a pack output directory.
 * @returns Tarball filenames in upload order.
 */
export function readPublishOrder(directory: string): string[] {
  return readFileSync(join(directory, PUBLISH_ORDER_FILE), 'utf8').split('\n').filter(line => line !== '')
}
