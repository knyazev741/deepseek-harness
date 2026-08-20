/**
 * Stateful child profile tests. A state root is one explicit host-owned
 * directory, not a generic additional writable-root list.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

function roots(): { workspaceRoot: string; stateRoot: string } {
  return {
    workspaceRoot: mkdtempSync(join(tmpdir(), 'dsh-profile-workspace-')),
    stateRoot: realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-profile-state-'))),
  }
}

describe('state-root profile grants', () => {
  it('binds the canonical state root in the bwrap workspace-write profile', () => {
    const { workspaceRoot, stateRoot } = roots()
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot, stateRoot }
    expect(bwrapProfileArgs(policy)).toEqual([
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent',
      '--tmpfs', '/tmp', '--bind', workspaceRoot, workspaceRoot,
      '--bind', stateRoot, stateRoot,
    ])
  })

  it('adds the canonical state root to Landlock workspace-write grants', () => {
    const { workspaceRoot, stateRoot } = roots()
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot, stateRoot }
    expect(landlockProfileArgs(policy)).toEqual([
      '--ro', '/', '--rw', '/dev/null', '--rw', '/tmp', '--rw', workspaceRoot, '--rw', stateRoot,
    ])
  })

  it('adds the canonical state root once to the Seatbelt workspace-write profile', () => {
    const { workspaceRoot, stateRoot } = roots()
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot, stateRoot }
    const profile = seatbeltProfileArgs(policy)[1]
    expect(profile).toContain(`(subpath "${stateRoot}")`)
    expect(profile?.split(`(subpath "${stateRoot}")`)).toHaveLength(2)
  })

  it('does not mention a state root in read-only profiles', () => {
    const { workspaceRoot, stateRoot } = roots()
    const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot, stateRoot }
    expect(bwrapProfileArgs(policy)).not.toContain(stateRoot)
    expect(landlockProfileArgs(policy)).not.toContain(stateRoot)
    expect(seatbeltProfileArgs(policy)[1]).not.toContain(stateRoot)
  })

  it('rejects a relative state root before constructing a workspace-write profile', () => {
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/workspace', stateRoot: 'relative/state' }
    expect(() => bwrapProfileArgs(policy)).toThrow(/stateRoot must be absolute/u)
    expect(() => landlockProfileArgs(policy)).toThrow(/stateRoot must be absolute/u)
    expect(() => seatbeltProfileArgs(policy)).toThrow(/stateRoot must be absolute/u)
  })

  it('rejects an existing relative state root before canonicalization', () => {
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/workspace', stateRoot: '.' }
    expect(() => bwrapProfileArgs(policy)).toThrow(/stateRoot must be absolute/u)
    expect(() => landlockProfileArgs(policy)).toThrow(/stateRoot must be absolute/u)
    expect(() => seatbeltProfileArgs(policy)).toThrow(/stateRoot must be absolute/u)
  })
})
