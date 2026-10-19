import { expect, it } from 'vitest'
import { SessionId } from '@knyazevai/dsh-session'
import { fixture } from './fixture.ts'

it('shares pins with native Workspace actions and detects a stale observed revision', async () => {
  const { ctx } = await fixture()
  const service = ctx.forkWorkspaceSessionState
  const first = await service.list()
  await ctx.workspaceRegistry.pinSession(SessionId('s1'))
  expect(await service.setPinned({ sessionId: SessionId('s2'), pinned: true, expectedRevision: first.revision }))
    .toMatchObject({ ok: false, error: { code: 'revision-conflict', current: { pinnedSessionIds: ['s1'] } } })
  const next = await service.list()
  expect(await service.setPinned({ sessionId: SessionId('s2'), pinned: true, expectedRevision: next.revision }))
    .toMatchObject({ ok: true, value: { pinnedSessionIds: ['s2', 's1'] } })
  await ctx.workspaceRegistry.unpinSession(SessionId('s1'))
  expect((await service.list()).pinnedSessionIds).toEqual(['s2'])
})

it('serializes competing writes, rejects unknown pins and preserves a no-op revision', async () => {
  const { ctx } = await fixture()
  const service = ctx.forkWorkspaceSessionState
  const { revision } = await service.list()
  expect(await service.setPinned({ sessionId: SessionId('unknown'), pinned: true, expectedRevision: revision }))
    .toMatchObject({ ok: false, error: { code: 'session-not-in-workspace' } })
  const results = await Promise.all(['s1', 's2'].map(id => service.setPinned({ sessionId: SessionId(id), pinned: true, expectedRevision: revision })))
  expect(results.filter(result => result.ok)).toHaveLength(1)
  const current = await service.list()
  expect(await service.setPinned({ sessionId: current.pinnedSessionIds[0]!, pinned: true, expectedRevision: current.revision }))
    .toEqual({ ok: true, value: current })
})

it('native archival removes a pin from both views', async () => {
  const { ctx } = await fixture()
  await ctx.workspaceRegistry.pinSession(SessionId('s1'))
  await ctx.workspaceRegistry.archiveSession(SessionId('s1'))
  expect((await ctx.forkWorkspaceSessionState.list()).pinnedSessionIds).toEqual([])
})
