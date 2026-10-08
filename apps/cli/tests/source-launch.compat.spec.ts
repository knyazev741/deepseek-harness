import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { removeFixtureSafely } from '../../../scripts/test-fixture-cleanup.ts'
import { testProfileResolution } from './profiles/headless/tests/profile-resolution.ts'

/**
 * Keyless source-launch and profile-resolution checks through the production
 * tsx ESM-only entry. The Node compatibility matrix runs this file without a
 * build; source tool execution with native/generated dependencies belongs to
 * the build-backed source-tool suite.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'

describe('dsh SOURCE launcher (node --import tsx/esm)', () => {
  testProfileResolution('src')

  it('launches the source CLI without building', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.dsh).toBe('node --import tsx/esm scripts/repo-dsh.ts')
  })

  it('resolves the checkout CLI through npx after workspace installation', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-source-launcher-'))
    try {
      const result = await execa('npx', ['--no-install', '@knyazevai/dsh', 'web', '--dump-default-config'], {
        cwd: repoRoot,
        env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: 'caller-controlled' },
        timeout: 30_000,
        killSignal: 'SIGKILL',
        reject: false,
      })
      if (result.timedOut) {
        throw new Error(`npx dsh launch did not exit within 30s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      }
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain('@knyazevai/dsh-fork-web')
    } finally {
      removeFixtureSafely(dshHome)
    }
  }, 35_000)

  it('boots the source entry and requires a profile', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-source-launcher-'))
    try {
      const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin], {
        cwd: repoRoot,
        input: '',
        env: { DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: 'caller-controlled' },
        timeout: 25_000,
        killSignal: 'SIGKILL',
        reject: false,
      })
      if (result.timedOut) {
        throw new Error(`dsh source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      }
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('--profile <name> is required')
      expect(result.stdout).toBe('')
    } finally {
      removeFixtureSafely(dshHome)
    }
  }, 30_000)
})
