import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Keyless smoke for SOURCE `dsh` execution: keep the repository launcher on
 * the ESM-only wrapper and run `apps/cli/src/bin.ts` directly with the same
 * `node --import tsx/esm` runtime vector to assert the required-config
 * diagnostic. The Node compatibility matrix runs this
 * WHOLE file, so a Node release changing module hooks or TypeScript handling
 * breaks this gate instead of every developer's `pnpm dsh`; the built-bin
 * suite covers the published `lib/` entry, not this source chain.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'

describe('dsh SOURCE launcher (node --import tsx/esm)', () => {
  it('launches the repository wrapper without building', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.dsh).toBe('node --import tsx/esm scripts/repo-dsh.ts')
  })

  it('resolves the checkout CLI through npx after workspace installation', async () => {
    const result = await execa('npx', ['--no-install', '@deepseek-ai/dsh', 'web', '--dump-default-config'], {
      cwd: repoRoot,
      env: { ...process.env, DSH_TELEMETRY_DISABLED: 'caller-controlled' },
      timeout: 30_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`npx dsh launch did not exit within 30s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('@deepseek-ai/dsh-fork-web')
  }, 35_000)

  it('boots the source entry and requires a profile', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin], {
      cwd: repoRoot,
      input: '',
      env: { DSH_TELEMETRY_DISABLED: 'caller-controlled' },
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
  }, 30_000)
})
