/** Locate npm without invoking a platform shell shim. */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** @returns npm's JavaScript entry installed beside the current Node executable. */
export function npmCliPath(): string {
  const directory = dirname(process.execPath)
  const candidates = [join(directory, '../lib/node_modules/npm/bin/npm-cli.js'), join(directory, 'node_modules/npm/bin/npm-cli.js')]
  const path = candidates.find(candidate => existsSync(candidate))
  if (path === undefined) throw new Error('Release tooling requires npm installed beside Node.js')
  return path
}
