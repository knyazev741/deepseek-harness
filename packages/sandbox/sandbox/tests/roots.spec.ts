/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalPath, canonicalStateRoot, writableRoots } from '@deepseek-ai/dsh-sandbox'

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })

  it.skipIf(process.platform === 'win32')('canonicalizes an absolute symlink alias for a state root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-state-alias-'))
    const target = mkdtempSync(join(parent, 'target-'))
    const alias = join(parent, 'alias')
    symlinkSync(target, alias, 'dir')
    expect(canonicalStateRoot(alias)).toBe(realpathSync.native(target))
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(roots).toContain(realpathSync.native(ws))
    expect(roots).toContain(canonicalPath('/tmp'))
    expect(roots).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('workspace-write grants the canonical state root and deduplicates it with existing roots', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const state = mkdtempSync(join(tmpdir(), 'dsh-state-'))
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ws, stateRoot: state })
    expect(roots).toContain(realpathSync.native(state))
    expect(new Set(roots).size).toBe(roots.length)

    const duplicate = writableRoots({ mode: 'workspace-write', workspaceRoot: ws, stateRoot: ws })
    expect(duplicate.filter(root => root === realpathSync.native(ws))).toHaveLength(1)
  })

  it('read-only ignores the state root', () => {
    const state = mkdtempSync(join(tmpdir(), 'dsh-state-'))
    expect(writableRoots({ mode: 'read-only', workspaceRoot: '/workspace', stateRoot: state })).toEqual([])
  })
})
