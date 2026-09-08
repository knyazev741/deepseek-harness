import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('repository dsh launcher', () => {
  it('boots the fork Web composition for pnpm dsh web', () => {
    const result = spawnSync('pnpm', ['dsh', 'web', '--dump-default-config'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('@knyazevai/dsh-fork-web')
  })
})
