/** A release cannot build or publish from dirty, feature, or stale sources. */
import { afterEach, expect, it, vi } from 'vitest'
import { capture } from './process.ts'
import { assertMainSource } from './assert-main.ts'

vi.mock('./process.ts', () => ({ capture: vi.fn(), isEntry: () => false }))
afterEach(() => { vi.resetAllMocks() })
const SHA = 'a'.repeat(40)

function fixture(dirty = '', branch = 'main', remote = SHA): void {
  vi.mocked(capture).mockImplementation((_command, args) => {
    switch (args[0]) {
      case 'status': return dirty
      case 'branch': return branch
      case 'rev-parse': return SHA
      case 'ls-remote': return `${remote}\trefs/heads/main`
      default: throw new Error('Unexpected git command')
    }
  })
}

it.each(['main', ''])('accepts clean current main with branch name %j', (branch) => {
  fixture('', branch)
  expect(assertMainSource()).toBe(SHA)
})
it('refuses uncommitted or untracked source changes', () => {
  fixture(' M package.json')
  expect(assertMainSource).toThrow('clean source checkout')
})
it('refuses a feature branch even at the same commit', () => {
  fixture('', 'codex/feature')
  expect(assertMainSource).toThrow('requires main')
})
it('refuses a detached commit after remote main moves', () => {
  fixture('', '', 'b'.repeat(40))
  expect(assertMainSource).toThrow('Remote main moved')
})
