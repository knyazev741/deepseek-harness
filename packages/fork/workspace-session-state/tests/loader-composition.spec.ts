import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionId } from '@knyazevai/dsh-session'
import { remoteMethods } from '@knyazevai/dsh-typert-protocol'
import { fixture } from './fixture.ts'

it('imports the former Settings pin list, preserves order across restart, and does not repin an explicit unpin', async () => {
  const { ctx, start, home } = await fixture(['s2', 's1'])
  await vi.waitFor(async () => { expect((await ctx.forkWorkspaceSessionState.list()).pinnedSessionIds).toEqual(['s2', 's1']) })
  expect(readFileSync(join(home, 'settings.yaml.imported'), 'utf8')).toContain('s2')
  expect(ctx.settings.describe().find(row => row.ns === 'fork-workspace-session-state')?.value).toEqual({ pins: { sessionIds: [] } })
  await ctx.workspaceRegistry.unpinSession(SessionId('s2'))
  await ctx.fiber.dispose()
  const restored = await start()
  expect((await restored.forkWorkspaceSessionState.list()).pinnedSessionIds).toEqual(['s1'])
  expect(remoteMethods(restored.forkWorkspaceSessionState).map(marker => marker.exportName ?? marker.method)).toEqual(['list', 'setPinned'])
  const entry = [...restored.loader.entries()].find(row => row.options.id === 'fork-workspace-session-state')!
  entry.parent.remove(entry.options.id)
  expect(restored.get('forkWorkspaceSessionState')).toBeUndefined()
})
