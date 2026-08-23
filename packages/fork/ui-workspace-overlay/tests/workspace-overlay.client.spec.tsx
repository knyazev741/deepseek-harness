// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, cleanup } from '@testing-library/react'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {
  SessionId, SessionSummary, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  WorkspaceContributions, WorkspaceListPolicy, WorkspaceListView, WorkspaceSessionRowContext,
} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ForkWorkspaceSessionStateView } from '@deepseek-ai/dsh-fork-workspace-session-state/types'
import type {} from '@deepseek-ai/dsh-fork-session-source/types'
import * as overlayClient from '@deepseek-ai/dsh-fork-ui-workspace-overlay/client'
import { apply, inject, NS } from '../src/client/index.ts'
import { parseReadWatermarks, READ_WATERMARKS_STORAGE_KEY } from '../src/client/store.ts'

afterEach(cleanup)

type TestRuntime = Awaited<ReturnType<typeof SlotTestRuntime.create>>

const sid = (value: string): SessionId => value as SessionId
const wid = (value: string): WorkspaceId => value as WorkspaceId

type OverlaySummary = Partial<Omit<SessionSummary, 'id'>> & { projectionAsOfSeq?: number }

interface RemoteFixture {
  readonly list: ReturnType<typeof vi.fn>
  readonly setPinned: ReturnType<typeof vi.fn>
  setView(view: ForkWorkspaceSessionStateView): void
  queueList(result: Promise<{ ok: true; value: ForkWorkspaceSessionStateView }>): void
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function createContributions(): WorkspaceContributions {
  let views: readonly WorkspaceListView[] = []
  let policies: readonly WorkspaceListPolicy[] = []
  const listeners = new Set<() => void>()
  const viewEntries = new Map<string, WorkspaceListView>()
  const policyEntries = new Map<string, WorkspaceListPolicy>()
  const refresh = (): void => {
    views = [...viewEntries.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    policies = [...policyEntries.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    for (const listener of [...listeners]) listener()
  }
  const source = <T,>(read: () => readonly T[]): HostObservable<readonly T[]> => ({
    getSnapshot: read,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  return {
    views: source(() => views),
    policies: source(() => policies),
    registerView(view) { viewEntries.set(view.id, view); refresh(); return () => { viewEntries.delete(view.id); refresh() } },
    registerPolicy(policy) { policyEntries.set(policy.id, policy); refresh(); return () => { policyEntries.delete(policy.id); refresh() } },
  }
}

function makeRemote(initial: ForkWorkspaceSessionStateView): RemoteFixture {
  let view = initial
  const queuedLists: Array<Promise<{ ok: true; value: ForkWorkspaceSessionStateView }>> = []
  const list = vi.fn(async () => queuedLists.shift() ?? ({ ok: true as const, value: view }))
  const setPinned = vi.fn(async (input: { sessionId: SessionId; pinned: boolean; expectedRevision: number }) => {
    if (input.expectedRevision !== view.revision) {
      return {
        ok: true as const,
        value: {
          ok: false as const,
          error: { code: 'revision-conflict' as const, current: view },
        },
      }
    }
    view = {
      revision: view.revision + 1,
      pinnedSessionIds: input.pinned
        ? [...view.pinnedSessionIds, input.sessionId]
        : view.pinnedSessionIds.filter(id => id !== input.sessionId),
    }
    return { ok: true as const, value: { ok: true as const, value: view } }
  })
  return {
    list,
    setPinned,
    setView(next) { view = next },
    queueList(result) { queuedLists.push(result) },
  }
}

function summary(id: string, extra: OverlaySummary = {}): SessionSummary {
  return {
    id: sid(id),
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt: 1,
    ...extra,
  } as SessionSummary
}

function workspace(sessionIds: readonly string[]): WorkspaceView {
  return {
    workspaceId: wid('workspace'),
    title: 'Workspace',
    path: '/workspace',
    sessionIds: sessionIds.map(sid),
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  }
}

async function bench(options: {
  summaries?: readonly SessionSummary[]
  pins?: ForkWorkspaceSessionStateView
  initialList?: Promise<{ ok: true; value: ForkWorkspaceSessionStateView }>
  mountOverlay?: boolean
  beforeMount?: (runtime: TestRuntime) => void
} = {}) {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('workspaceContributions', createContributions())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const remote = makeRemote(options.pins ?? { revision: 1, pinnedSessionIds: [] })
  if (options.initialList !== undefined) remote.queueList(options.initialList)
  runtime.provide('remote', { forkWorkspaceSessionState: remote } as never)
  runtime.provide('remote.forkWorkspaceSessionState', remote as never)
  for (const item of options.summaries ?? []) {
    await runtime.sessions.add({ id: String(item.id), summary: item as never }, { current: false })
  }
  const ids = (options.summaries ?? []).map(item => String(item.id))
  await runtime.workspaces.update((draft) => { draft.items = [workspace(ids)] })
  await runtime.declare({
    'workspace.session-row.badges': { kind: 'list', scope: 'root' },
    'workspace.session-row.actions': { kind: 'list', scope: 'root' },
  })
  options.beforeMount?.(runtime)
  const feature = options.mountOverlay === false
    ? undefined
    : await runtime.mount({ inject: [...inject], apply })
  await runtime.flush()
  return { runtime, remote, feature, workspace: workspace(ids) }
}

function owner(session: SessionSummary, workspaceView: WorkspaceView = workspace([String(session.id)])): WorkspaceSessionRowContext {
  return { session, workspace: workspaceView, selected: false }
}

describe('fork workspace overlay assembled client fixture', () => {
  it('uses an empty fallback for malformed browser state and keeps pins out of localStorage', async () => {
    localStorage.setItem(READ_WATERMARKS_STORAGE_KEY, '{"read-me":"not-a-sequence"}')
    expect(parseReadWatermarks(localStorage.getItem(READ_WATERMARKS_STORAGE_KEY))).toEqual({})
    const session = summary('read-me', { projectionAsOfSeq: 4 })
    const b = await bench({ summaries: [session], pins: { revision: 3, pinnedSessionIds: [sid('read-me')] } })
    const view = b.runtime.renderSlot('workspace.session-row.actions', owner(session, b.workspace))
    fireEvent.click(view.view.getByRole('button', { name: 'Mark unread' }))
    expect(JSON.parse(localStorage.getItem(READ_WATERMARKS_STORAGE_KEY)!)).toEqual({ 'read-me': 3 })
    expect(localStorage.getItem(READ_WATERMARKS_STORAGE_KEY)).not.toContain('pinnedSessionIds')
    await b.runtime.dispose()
  })

  it('parses an opaque __proto__ id without changing the watermark map prototype', () => {
    const parsed = parseReadWatermarks('{"__proto__":4}')
    expect(Object.getPrototypeOf(parsed)).toBeNull()
    expect(parsed['__proto__']).toBe(4)
  })

  it('copies the exact opaque id and reports clipboard rejection accessibly', async () => {
    const session = summary('opaque/session::7')
    const b = await bench({ summaries: [session] })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const view = b.runtime.renderSlot('workspace.session-row.actions', owner(session, b.workspace))
    fireEvent.click(view.view.getByRole('button', { name: 'Copy session ID' }))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('opaque/session::7'))

    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(view.view.getByRole('button', { name: 'Copy session ID' }))
    expect((await view.view.findByRole('status')).textContent).toContain('Clipboard access was denied')
    await b.runtime.dispose()
  })

  it('stores unread below lastSeq and advances the watermark when opening', async () => {
    const session = summary('read-me', { projectionAsOfSeq: 9 })
    const other = summary('other', { projectionAsOfSeq: 2 })
    const b = await bench({ summaries: [session, other] })
    const view = b.runtime.renderSlot('workspace.session-row.actions', owner(session, b.workspace))
    fireEvent.click(view.view.getByRole('button', { name: 'Mark unread' }))
    expect(JSON.parse(localStorage.getItem(READ_WATERMARKS_STORAGE_KEY)!)).toMatchObject({ 'read-me': 8 })

    await b.runtime.sessions.setCurrent(String(session.id))
    await b.runtime.sessions.updateSummary(String(session.id), { projectionAsOfSeq: 10 } as never)
    await b.runtime.sessions.setCurrent(String(other.id))
    await b.runtime.sessions.setCurrent(String(session.id))
    expect(JSON.parse(localStorage.getItem(READ_WATERMARKS_STORAGE_KEY)!)).toMatchObject({ 'read-me': 10 })
    await b.runtime.dispose()
  })

  it('does not lower a newer read watermark when a stale summary is marked read', async () => {
    const session = summary('stale-read', { projectionAsOfSeq: 9 })
    const b = await bench({ summaries: [session] })
    await b.runtime.sessions.setCurrent(String(session.id))
    await b.runtime.sessions.setCurrent(undefined)
    await b.runtime.sessions.updateSummary(String(session.id), { projectionAsOfSeq: 10 } as never)
    await b.runtime.sessions.setCurrent(String(session.id))
    await b.runtime.sessions.setCurrent(undefined)
    await b.runtime.sessions.updateSummary(String(session.id), { projectionAsOfSeq: 3 } as never)
    await b.runtime.sessions.setCurrent(String(session.id))
    expect(JSON.parse(localStorage.getItem(READ_WATERMARKS_STORAGE_KEY)!)).toMatchObject({ 'stale-read': 10 })
    await b.runtime.dispose()
  })

  it('filters Background to running or exact GitHub Actions source', async () => {
    const live = summary('live', { running: true })
    const github = summary('github', { projectionValues: { forkSessionSource: 'github-actions' } })
    const idle = summary('idle', { projectionValues: { forkSessionSource: null } })
    const b = await bench({ summaries: [live, github, idle] })
    const views = b.runtime.ctx.workspaceContributions.views.getSnapshot()
    const background = views.find(view => view.id === 'fork.background')!
    const result = (item: SessionSummary) => background.include(owner(item, b.workspace))
    expect(result(live)).toBe(true)
    expect(result(github)).toBe(true)
    expect(result(idle)).toBe(false)
    await b.runtime.dispose()
  })

  it('updates the Background label when the runtime locale changes', async () => {
    const b = await bench({ summaries: [summary('locale-me', { running: true })] })
    b.runtime.ctx.locale.setLocale('zh')
    await vi.waitFor(() => expect(
      b.runtime.ctx.workspaceContributions.views.getSnapshot().find(view => view.id === 'fork.background')?.label,
    ).toBe('后台'))
    await b.runtime.dispose()
  })

  it('does not re-register Background after teardown wins a locale snapshot', async () => {
    let disposeRequested = false
    const disposeOverlay: { current?: () => Promise<void> } = {}
    const b = await bench({
      beforeMount: (runtime) => {
        // Register before the overlay so this callback can dispose it after
        // LocaleRuntime snapshots listeners but before the overlay callback.
        runtime.ctx.locale.subscribe(() => {
          if (!disposeRequested) return
          disposeRequested = false
          void disposeOverlay.current?.()
        })
      },
    })
    disposeOverlay.current = async () => { await b.feature?.dispose() }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      disposeRequested = true
      b.runtime.ctx.locale.setLocale('zh')
      await vi.waitFor(() => expect(b.runtime.ctx.workspaceContributions.views.getSnapshot()).toEqual([]))
      expect(error).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('renders the GitHub Actions badge only for the exact projection value', async () => {
    const github = summary('github', { projectionValues: { forkSessionSource: 'github-actions' } })
    const ordinary = summary('ordinary', { projectionValues: { forkSessionSource: null } })
    const b = await bench({ summaries: [github, ordinary] })
    const githubView = b.runtime.renderSlot('workspace.session-row.badges', owner(github, b.workspace))
    expect(githubView.view.getByText('GitHub Actions')).toBeTruthy()
    githubView.update(owner(ordinary, b.workspace))
    expect(githubView.view.queryByText('GitHub Actions')).toBeNull()
    await b.runtime.dispose()
  })

  it('uses the observed revision and does not replay a stale pin mutation', async () => {
    const session = summary('pin-me')
    const b = await bench({ summaries: [session] })
    b.remote.setView({ revision: 2, pinnedSessionIds: [] })
    const view = b.runtime.renderSlot('workspace.session-row.actions', owner(session, b.workspace))
    fireEvent.click(view.view.getByRole('button', { name: 'Pin session' }))
    await vi.waitFor(() => expect(b.remote.setPinned).toHaveBeenCalledTimes(1))
    expect(b.remote.setPinned.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 1 })
    expect(b.remote.list).toHaveBeenCalledTimes(2)
    expect(b.remote.setPinned).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(view.view.getByRole('button', { name: 'Pin session' }).getAttribute('disabled')).toBeNull())
    fireEvent.click(view.view.getByRole('button', { name: 'Pin session' }))
    await vi.waitFor(() => expect(b.remote.setPinned).toHaveBeenCalledTimes(2))
    expect(b.remote.setPinned.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 2, pinned: true })
    await b.runtime.dispose()
  })

  it('keeps an accepted pin when an older initial list resolves late', async () => {
    const initial = { revision: 0, pinnedSessionIds: [] as SessionId[] }
    const initialList = deferred<{ ok: true; value: ForkWorkspaceSessionStateView }>()
    const b = await bench({ summaries: [summary('pin-race')], pins: initial, initialList: initialList.promise })
    const session = summary('pin-race')
    const view = b.runtime.renderSlot('workspace.session-row.actions', owner(session, b.workspace))
    fireEvent.click(view.view.getByRole('button', { name: 'Pin session' }))
    await vi.waitFor(() => expect(view.view.getByRole('button', { name: 'Unpin session' })).toBeTruthy())
    initialList.resolve({ ok: true, value: initial })
    await Promise.resolve()
    expect(view.view.getByRole('button', { name: 'Unpin session' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('accepts pin then unpin with each current revision', async () => {
    const session = summary('toggle-pin')
    const b = await bench({ summaries: [session] })
    const view = b.runtime.renderSlot('workspace.session-row.actions', owner(session, b.workspace))
    fireEvent.click(view.view.getByRole('button', { name: 'Pin session' }))
    await vi.waitFor(() => expect(view.view.getByRole('button', { name: 'Unpin session' })).toBeTruthy())
    fireEvent.click(view.view.getByRole('button', { name: 'Unpin session' }))
    await vi.waitFor(() => expect(view.view.getByRole('button', { name: 'Pin session' })).toBeTruthy())
    expect(b.remote.setPinned.mock.calls.map(call => call[0])).toMatchObject([
      { expectedRevision: 1, pinned: true },
      { expectedRevision: 2, pinned: false },
    ])
    await b.runtime.dispose()
  })

  it('ignores a late initial pin list after disposal', async () => {
    const initialList = deferred<{ ok: true; value: ForkWorkspaceSessionStateView }>()
    const b = await bench({ summaries: [summary('dispose-race')], initialList: initialList.promise })
    await b.feature?.dispose()
    initialList.resolve({ ok: true, value: { revision: 9, pinnedSessionIds: [sid('dispose-race')] } })
    await Promise.resolve()
    expect(b.runtime.ctx.workspaceContributions.views.getSnapshot()).toEqual([])
    expect(b.runtime.ctx.workspaceContributions.policies.getSnapshot()).toEqual([])
    await b.runtime.dispose()
  })

  it('partitions pinned sessions first and returns zero within each stable partition', async () => {
    const first = summary('first')
    const pinned = summary('pinned')
    const secondPinned = summary('second-pinned')
    const last = summary('last')
    const b = await bench({
      summaries: [first, pinned, secondPinned, last],
      pins: { revision: 4, pinnedSessionIds: [sid('pinned'), sid('second-pinned')] },
    })
    await Promise.resolve()
    const policy = b.runtime.ctx.workspaceContributions.policies.getSnapshot().find(item => item.id === 'fork.pinned-first')!
    expect(policy.compare(owner(pinned), owner(secondPinned))).toBe(0)
    expect(policy.compare(owner(first), owner(last))).toBe(0)
    const ordered = [first, pinned, last, secondPinned].sort((left, right) => policy.compare(owner(left), owner(right)))
    expect(ordered.map(item => item.id)).toEqual([sid('pinned'), sid('second-pinned'), sid('first'), sid('last')])
    await b.runtime.dispose()
  })

  it('disposes contributions, row entries, read subscription, and locale namespace', async () => {
    const session = summary('dispose-me', { projectionAsOfSeq: 4 })
    const b = await bench({ summaries: [session] })
    expect(b.runtime.ctx.workspaceContributions.views.getSnapshot()).toHaveLength(1)
    expect(b.runtime.slots.entries('workspace.session-row.badges')).toHaveLength(1)
    expect(b.runtime.slots.entries('workspace.session-row.actions')).toHaveLength(3)
    expect(b.runtime.ctx.locale.bind(NS)('background')).toBe('Background')
    await b.feature?.dispose()
    expect(b.runtime.ctx.workspaceContributions.views.getSnapshot()).toEqual([])
    expect(b.runtime.ctx.workspaceContributions.policies.getSnapshot()).toEqual([])
    expect(b.runtime.slots.entries('workspace.session-row.badges')).toEqual([])
    expect(b.runtime.slots.entries('workspace.session-row.actions')).toEqual([])
    expect(b.runtime.ctx.locale.bind(NS)('background')).toBe('background')
    await b.runtime.sessions.setCurrent(String(session.id))
    expect(localStorage.getItem(READ_WATERMARKS_STORAGE_KEY)).toBeNull()
    await b.runtime.dispose()
  })

  it('loads the public client entry through Loader and exposes only the bootstrap face', async () => {
    expect(Object.keys(overlayClient).sort()).toEqual(['NS', 'apply', 'inject'])
  })

  it('composes the package client entry through Loader and cordis.yml', async () => {
    const b = await bench({ summaries: [summary('loader-me')], mountOverlay: false })
    let disposed = false
    try {
      const configUrl = pathToFileURL(join(
        process.cwd(), 'packages/fork/ui-workspace-overlay/tests/fixtures/loader-composition/cordis.yml',
      ))
      b.runtime.ctx.baseUrl = pathToFileURL(join(
        process.cwd(), 'packages/fork/ui-workspace-overlay/tests/fixtures/loader-composition/',
      )).href
      await b.runtime.ctx.plugin(Loader)
      b.runtime.ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-fork-ui-workspace-overlay', overlayClient],
      ])
      b.runtime.ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof b.runtime.ctx.loader.internal>
      await b.runtime.ctx.loader.create({ name: 'cordis:include', config: { path: configUrl.href } })
      await b.runtime.ctx.loader.await()

      expect(b.runtime.ctx.workspaceContributions.views.getSnapshot().map(view => view.id)).toEqual(['fork.background'])
      expect(b.runtime.slots.entries('workspace.session-row.badges')).toHaveLength(1)
      expect(b.runtime.slots.entries('workspace.session-row.actions')).toHaveLength(3)
      const entry = [...b.runtime.ctx.loader.entries()].find(
        candidate => candidate.options.name === '@deepseek-ai/dsh-fork-ui-workspace-overlay',
      )
      expect(entry).toBeDefined()

      await b.runtime.ctx.fiber.dispose()
      disposed = true
      expect(b.runtime.ctx.get('workspaceContributions')).toBeUndefined()
    } finally {
      if (!disposed) await b.runtime.ctx.fiber.dispose()
    }
  })
})
