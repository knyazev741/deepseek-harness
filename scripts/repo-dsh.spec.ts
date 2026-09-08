import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('repository dsh launcher', () => {
  it('boots the fork Web composition for pnpm dsh web', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-repo-launcher-'))
    try {
      const result = spawnSync('pnpm', ['dsh', 'web', '--dump-default-config'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: dshHome },
      })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('@knyazevai/dsh-fork-web')
    } finally {
      rmSync(dshHome, { recursive: true, force: true })
    }
  })
})
