#!/usr/bin/env node

// A workspace install must run the checkout's source launcher; an npm install
// outside the repository must run the packaged build.

import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const packageRoot = dirname(realpathSync(fileURLToPath(import.meta.url)))
const repositoryRoot = resolve(packageRoot, '../..')
const repositoryEntry = join(repositoryRoot, 'scripts/repo-dsh.ts')
const inRepository = existsSync(repositoryEntry) && existsSync(join(repositoryRoot, 'pnpm-workspace.yaml'))
const args = inRepository
  ? ['--import', 'tsx/esm', repositoryEntry, ...process.argv.slice(2)]
  : [join(packageRoot, 'lib/bin.js'), ...process.argv.slice(2)]
const result = spawnSync(process.execPath, args, { env: process.env, stdio: 'inherit' })

if (result.error !== undefined) {
  process.stderr.write(`dsh: could not start Node: ${result.error.message}\n`)
  process.exit(1)
}

process.exit(result.status ?? 1)
