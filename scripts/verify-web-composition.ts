/** Build a clean Web artifact set, render each selected profile, and inspect only the emitted output. */

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { inspectWebComposition } from './web-composition/inspect.ts'
import type { WebCompositionEvidence, WebCompositionProfile } from './web-composition/types.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const profileNames: readonly WebCompositionProfile[] = ['web', 'fork-web']

/** Parse the one required profile selector used by the package script. */
function selectedProfile(): WebCompositionProfile {
  const args = process.argv.slice(2)
  const forwardedArgs = args[0] === '--' ? args.slice(1) : args
  const { values } = parseArgs({
    args: forwardedArgs,
    options: { profile: { type: 'string' } },
    allowPositionals: false,
  })
  const profile = values.profile
  if (typeof profile !== 'string' || !profileNames.includes(profile as WebCompositionProfile)) {
    throw new Error('verify-web-composition: use --profile web or --profile fork-web')
  }
  return profile as WebCompositionProfile
}

/** Run one shell-free package-manager command and fail with its exit status. */
function runPnpm(args: readonly string[]): void {
  const invocation = pnpmInvocation(args)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`verify-web-composition: ${args.join(' ')} exited with ${String(result.status ?? result.signal)}`)
  }
}

/** Create an isolated profile home and add the optional bundle that is not an app dependency. */
function stageProfileHome(profile: WebCompositionProfile): string {
  const home = mkdtempSync(join(tmpdir(), `dsh-web-composition-home-${profile}-`))
  if (profile !== 'fork-web') return home
  const profileModules = join(home, 'profiles', profile, 'node_modules', '@knyazevai')
  mkdirSync(profileModules, { recursive: true })
  for (const bundle of ['fork-base', 'fork-web'] as const) {
    symlinkSync(resolve(repositoryRoot, `packages/bundle/${bundle}`), join(profileModules, `dsh-${bundle}`), 'dir')
  }
  return home
}

/** Spawn the built source CLI, fetch its Host-rendered index, and stop its server. */
async function renderedIndex(profile: WebCompositionProfile, home: string): Promise<string> {
  const nodePath = [
    resolve(repositoryRoot, 'node_modules/.pnpm/node_modules'),
    process.env.NODE_PATH,
  ].filter((value): value is string => value !== undefined && value !== '').join(delimiter)
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', profile, '--port', '0',
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      NODE_PATH: nodePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  let diagnostics = ''
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        reject(error)
      }
      const read = (chunk: Buffer): void => {
        output += chunk.toString()
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)
        if (match?.[1] !== undefined && !settled) {
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          resolveUrl(match[1])
        }
      }
      child.stdout.on('data', read)
      child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
      child.once('error', fail)
      child.once('exit', (code, signal) => {
        if (!settled) {
          fail(new Error(`profile ${profile} exited before serving Web (code=${String(code)}, signal=${String(signal)})\n${diagnostics}`))
        }
      })
      timer = setTimeout(() => {
        fail(new Error(`profile ${profile} did not publish a Web URL within 30s\n${diagnostics}`))
      }, 30_000)
    })
    const response = await fetch(`${url}/`)
    if (!response.ok) throw new Error(`profile ${profile} served index with HTTP ${String(response.status)}`)
    return await response.text()
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) {
        resolveExit()
        return
      }
      const stopTimer = setTimeout(() => {
        child.kill('SIGKILL')
        resolveExit()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(stopTimer)
        resolveExit()
      })
    })
  }
}

/** Build, stage, render, inspect, and clean one selected Web composition. */
async function verify(profile: WebCompositionProfile): Promise<WebCompositionEvidence> {
  runPnpm(['run', 'build:official'])
  const outputRoot = mkdtempSync(join(tmpdir(), `dsh-web-composition-output-${profile}-`))
  const home = stageProfileHome(profile)
  let validated = false
  try {
    // Vite emits into this temporary directory, so inspection never consumes a
    // stale or partially written apps/web/dist tree. The Host-rendered index
    // below is then copied into the same clean artifact root.
    runPnpm([
      '--filter', '@knyazevai/dsh-web-frontend', 'run', 'build',
      '--outDir', outputRoot,
    ])
    const sourceIndex = resolve(repositoryRoot, 'apps/web/dist/index.html')
    if (!existsSync(sourceIndex)) throw new Error('verify-web-composition: root Web build did not emit index.html')
    const html = await renderedIndex(profile, home)
    writeFileSync(join(outputRoot, 'index.html'), html)
    const evidence = inspectWebComposition(outputRoot, profile)
    validated = true
    return evidence
  } finally {
    rmSync(home, { recursive: true, force: true })
    if (validated) rmSync(outputRoot, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const profile = selectedProfile()
  const evidence = await verify(profile)
  console.log(`verify-web-composition: profile=${evidence.profile}`)
  console.log(`  css=${String(evidence.cssFiles.length)} bootstrap=${evidence.bootstrapModule}`)
  console.log(`  theme=${evidence.themePluginId}`)
  console.log(`  plugins=${evidence.pluginIds.join(', ')}`)
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
