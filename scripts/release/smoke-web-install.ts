/** Entry-only npm install and real browser startup, outside the source checkout. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { valid } from 'semver'
import { chromium, type Page } from 'playwright'
import { isEntry } from './process.ts'
import { startPackedRegistry } from './packed-registry.ts'

/**
 * Give the consumer its own home, npm settings, cache, and profile without inherited npm/API credentials or Node hooks.
 * @param root - private temporary consumer directory.
 * @param heapMb - maximum Node heap for the fresh npm and application processes.
 * @param registry - packed-test registry, or the public npm registry.
 * @returns the consumer's detached process environment.
 */
export function smokeEnvironment(root: string, heapMb: number, registry: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => [
    'PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  ].includes(name)))
  return {
    ...inherited,
    HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
    DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1',
    CI: '1', NODE_OPTIONS: `--max-old-space-size=${String(heapMb)}`,
    npm_config_cache: join(root, '.npm'), npm_config_prefix: join(root, 'global'),
    npm_config_userconfig: join(root, '.npmrc'), npm_config_globalconfig: join(root, 'global.npmrc'),
    npm_config_registry: registry, npm_config_yes: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
  }
}

/**
 * Redact one-use Web login parameters in retained diagnostics.
 * @param output - consumer stdout and stderr.
 * @returns output safe to retain with a public release's evidence.
 */
export function redactSmokeOutput(output: string): string {
  return output.replace(/([?&#](?:token|auth|access_token|key)=)[^\s&#]+/giu, '$1<redacted>')
}

function npmCli(): string {
  const directory = dirname(process.execPath)
  const candidates = [join(directory, '../lib/node_modules/npm/bin/npm-cli.js'), join(directory, 'node_modules/npm/bin/npm-cli.js')]
  const path = candidates.find(candidate => existsSync(candidate))
  if (path === undefined) throw new Error('The release smoke requires npm installed beside Node.js')
  return path
}

function signalOwned(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try { process.kill(-child.pid, signal) }
  catch (error) {
    // The npm process group can already be gone after an early install failure.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

interface SmokeOptions {
  readonly version: string
  readonly packedDirectory?: string
  readonly timeoutMs: number
  readonly heapMb: number
  readonly evidencePrefix: string
}

/**
 * Install only the CLI entry, launch its shipped Web profile, and require the browser shell to boot.
 * @param options - version, optional packed registry, resource budget, and retained evidence prefix.
 * @returns after the browser, process group, registry, and temporary home have closed.
 */
export async function smokeWebInstall(options: SmokeOptions): Promise<void> {
  if (process.platform === 'win32') throw new Error('This release smoke runs on Linux or macOS; Windows runtime checks have their own workflow')
  if (valid(options.version) !== options.version) throw new Error('Smoke version must be an exact npm version')
  const root = mkdtempSync(join(tmpdir(), 'dsh-npm-entry-'))
  let registry: Awaited<ReturnType<typeof startPackedRegistry>> | undefined
  let child: ChildProcess | undefined
  let completed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let page: Page | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let output = ''
  try {
    mkdirSync(dirname(options.evidencePrefix), { recursive: true })
    writeFileSync(join(root, '.npmrc'), '')
    writeFileSync(join(root, 'global.npmrc'), '')
    if (options.packedDirectory !== undefined) registry = await startPackedRegistry(options.packedDirectory)
    const ready = Promise.withResolvers<string>()
    child = spawn(process.execPath, [npmCli(), 'exec', '--yes', '--package', `@knyazevai/dsh@${options.version}`, '--', 'dsh', 'web', '--port', '0', '--no-open'], {
      cwd: root, env: smokeEnvironment(root, options.heapMb, registry?.url ?? 'https://registry.npmjs.org'),
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    completed = new Promise((resolve, reject) => {
      child?.once('error', reject)
      child?.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      writeFileSync(`${options.evidencePrefix}.log`, redactSmokeOutput(output), { mode: 0o600 })
      const url = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/u.exec(output)?.[1]
      if (url !== undefined) ready.resolve(url)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    timer = setTimeout(() => { ready.reject(new Error(`Fresh npm Web startup exceeded ${String(options.timeoutMs)}ms`)) }, options.timeoutMs)
    const url = await Promise.race([ready.promise, completed.then((result) => {
      throw new Error(`Fresh npm Web exited before readiness: ${JSON.stringify(result)}`)
    })])
    clearTimeout(timer)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
    await page.locator('[class*="frame"]').first().waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Choose workspace', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    if (await page.getByText('Failed to load plugins', { exact: false }).count() > 0 || errors.length > 0) {
      throw new Error(`Installed Web did not boot cleanly: ${errors.join('\n')}`)
    }
    await page.screenshot({ path: `${options.evidencePrefix}.png` })
    const report = { version: options.version, node: process.version, registry: registry === undefined ? 'public npm' : 'packed DSH with public external dependencies', heapMb: options.heapMb, browserErrors: errors, webOrigin: new URL(url).origin }
    writeFileSync(`${options.evidencePrefix}.json`, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`release smoke: @knyazevai/dsh@${options.version} installed from an empty cache and booted Web in Chromium`)
  } catch (error) {
    try { await page?.screenshot({ path: `${options.evidencePrefix}.failed.png` }) }
    catch (screenshotError) { console.warn(`release smoke: could not retain the failure screenshot: ${String(screenshotError)}`) }
    console.error(redactSmokeOutput(output))
    throw new Error(redactSmokeOutput(error instanceof Error ? error.message : String(error)))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try { await browser?.close() } finally {
      try {
        if (child !== undefined && completed !== undefined) {
          signalOwned(child, 'SIGTERM')
          const stopped = await Promise.race([completed.then(() => true), sleep(5000, undefined, { ref: false }).then(() => false)])
          if (!stopped) { signalOwned(child, 'SIGKILL'); await completed }
        }
      } finally {
        try { await registry?.close() } finally {
          writeFileSync(`${options.evidencePrefix}.log`, redactSmokeOutput(output), { mode: 0o600 })
          await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    version: { type: 'string' }, from: { type: 'string' }, evidence: { type: 'string' },
    'timeout-ms': { type: 'string', default: '600000' }, 'heap-mb': { type: 'string', default: '1536' },
  } })
  if (values.version === undefined || values.evidence === undefined) throw new Error('usage: smoke-web-install.ts --version <version> --evidence <prefix> [--from <packed DSH directory>]')
  const timeoutMs = Number(values['timeout-ms']), heapMb = Number(values['heap-mb'])
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(heapMb) || heapMb < 1) throw new Error('Smoke timeout and heap must be positive integers')
  await smokeWebInstall({ version: values.version, timeoutMs, heapMb, evidencePrefix: resolve(values.evidence),
    ...values.from === undefined ? {} : { packedDirectory: resolve(values.from) },
  })
}

if (isEntry(import.meta.url)) await main()
