import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

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
      removeFixtureSafely(dshHome)
    }
  })

  it('cleans a DSH home without traversing linked profile modules', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-repo-launcher-cleanup-'))
    const target = mkdtempSync(join(tmpdir(), 'dsh-repo-launcher-target-'))
    const targetMarker = join(target, 'marker')
    const link = join(dshHome, 'profiles/node_modules/linked')
    try {
      mkdirSync(join(dshHome, 'profiles/node_modules'), { recursive: true })
      writeFileSync(targetMarker, 'target')
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')

      removeFixtureSafely(dshHome)

      expect(existsSync(dshHome)).toBe(false)
      expect(existsSync(targetMarker)).toBe(true)
    } finally {
      removeFixtureSafely(dshHome)
      removeFixtureSafely(target)
    }
  })
})
