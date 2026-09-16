// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@knyazevai/dsh-client-ui-slots'
import type { SessionId } from '@knyazevai/dsh-session/types'
import type { SessionListState, SessionSummary } from '@knyazevai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot as WorkspaceListState, WorkspaceView } from '@knyazevai/dsh-api-workspace-controller/client'
import { bindSnapshotSelector, makeTranslate } from '@knyazevai/dsh-client-test-runtime'
import { zh as commonZh } from '@knyazevai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import type { WorkspaceListPolicy, WorkspaceListView, WorkspaceSessionRowContext } from '../src/client/contract/contributions.ts'
import { WorkspaceContributionsRuntime } from '../src/client/contributions.ts'
import { createWorkspaceViewStore, FLAT_SESSION_ORDER_KEY } from '../src/client/stores.ts'
import { WorkspaceBrowser } from '../src/client/rows/WorkspaceBrowser.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const session = (id: string): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 1,
})
const workspace = (sessionIds: readonly string[]): WorkspaceView => ({
  workspaceId: wid('workspace'), title: 'Workspace', path: '/workspace',
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01', updatedAt: '2026-01-01',
})
const list = (items: readonly SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id), byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
})
const workspaces = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
})
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
function source<T>(snapshot: T): HostObservable<T> {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

describe('workspace contributions', () => {
  it('sorts registries, rejects duplicate ids, and restores the empty snapshot on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(WorkspaceContributionsRuntime).await()
    const contributions = ctx.get('workspaceContributions')!
    const low = { id: 'b', order: 0, label: 'B', include: () => true }
    const high = { id: 'a', order: 0, label: 'A', include: () => true }
    const disposeLow = contributions.registerView(low)
    const disposeHigh = contributions.registerView(high)
    expect(contributions.views.getSnapshot().map(view => view.id)).toEqual(['a', 'b'])
    expect(() => contributions.registerView({ ...low })).toThrow(/already registered/)
    expect(() => contributions.registerView({ ...low, id: 'workspace.default' })).toThrow(/reserved/)
    disposeLow()
    disposeHigh()
    expect(contributions.views.getSnapshot()).toEqual([])
  })

  it('ties a registration to the contributing Cordis fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(WorkspaceContributionsRuntime).await()
    const fiber = ctx.plugin({
      inject: ['workspaceContributions'],
      apply: (scope) => { scope.workspaceContributions.registerView({ id: 'fiber', order: 0, label: 'Fiber', include: () => true }) },
    })
    await fiber.await()
    expect(ctx.get('workspaceContributions')!.views.getSnapshot().map(view => view.id)).toEqual(['fiber'])
    await fiber.dispose()
    expect(ctx.get('workspaceContributions')!.views.getSnapshot()).toEqual([])
  })

  it('keeps the default view without tabs, then filters and orders runtime contributions', async () => {
    const first = session('first')
    const second = session('second')
    const workspaceView = workspace(['first', 'second'])
    const store = createWorkspaceViewStore().create()
    store.actions.setOrderBy('manual', {})
    store.actions.setGroupExpanded('workspace', false)
    const includeSecond: WorkspaceListView = {
      id: 'featured', order: 10, label: 'Featured',
      include: ({ session: item }) => item.id === sid('second'),
    }
    const policy: WorkspaceListPolicy = {
      id: 'reverse', order: 10,
      compare: (left, right) => left.session.id === sid('second') && right.session.id === sid('first') ? -1 : 0,
    }
    const ctx = new Context()
    await ctx.plugin(WorkspaceContributionsRuntime).await()
    const contributions = ctx.get('workspaceContributions')!
    const disposeView = contributions.registerView(includeSecond)
    const disposePolicy = contributions.registerPolicy(policy)
    const renderSlot = ((name: string, owner: WorkspaceSessionRowContext) => {
      if (name === 'sidebar.workspaces.directoryFlow') return null
      return name === 'workspace.session-row.badges'
        ? <span data-testid={`badge-${owner.session.id}`}>badge</span>
        : <span data-testid={`action-${owner.session.id}`}>action</span>
    }) as never
    const t = makeTranslate(zh, commonZh) as WorkspaceBrowserProps['t']
    const props = {
      wide: true, expandSidebar: vi.fn(), useSessions: hook(list([first, second])),
      useWorkspaces: hook(workspaces([workspaceView])), useStore: bindSnapshotSelector(store), actions: store.actions,
      startSession: vi.fn(), open: vi.fn(), searchSessions: vi.fn(async () => ({ items: [], hasMore: false })),
      searchResultLimit: 20, renameSession: vi.fn(async () => {}), forkSession: vi.fn(),
      renameWorkspace: vi.fn(async () => {}), deleteWorkspace: vi.fn(async () => {}),
      archiveSession: vi.fn(async () => {}), insertWorkspaceBefore: vi.fn(async () => {}),
      insertSessionBefore: vi.fn(async () => {}), createWorkspace: vi.fn(async () => workspace([])),
      useDirectoryFlow: bindSnapshotSelector(source(true)),
      useHostInfo: (selector: (x: { home: undefined; isLoopback: boolean }) => unknown) => selector({ home: undefined, isLoopback: true }),
      usePanelInfo: hook({ activePanelId: null }),
      useSessionPendingInteraction: hook(new Map()),
      renderSlot, t,
      useViews: (selector: (items: readonly WorkspaceListView[]) => unknown) => selector(contributions.views.getSnapshot()),
      usePolicies: (selector: (items: readonly WorkspaceListPolicy[]) => unknown) => selector(contributions.policies.getSnapshot()),
    } as unknown as WorkspaceBrowserProps
    try {
      render(<WorkspaceBrowser {...props} />)
      expect(screen.getByRole('tablist')).toBeTruthy()
      fireEvent.click(screen.getByText('Workspace'))
      expect(screen.getByText('second')).toBeTruthy()
      expect(screen.getByText('first')).toBeTruthy()
      expect(screen.getAllByRole('treeitem').map(item => item.textContent)).toEqual([
        expect.stringContaining('Workspace'), expect.stringContaining('second'), expect.stringContaining('first'),
      ])
      expect(screen.getByTestId('badge-first')).toBeTruthy()
      expect(screen.getByTestId('action-second')).toBeTruthy()
      fireEvent.click(screen.getByRole('tab', { name: 'Featured' }))
      expect(screen.queryByText('first')).toBeNull()
      expect(screen.getByText('second')).toBeTruthy()
      expect(store.getSnapshot().sessionOrderByAccount.workspace).toEqual(['first', 'second'])
    } finally {
      disposeView()
      disposePolicy()
    }
  })

  it('preserves the default DOM and account order with zero contributors', () => {
    const first = session('first')
    const second = session('second')
    const workspaceView = workspace(['first', 'second'])
    const store = createWorkspaceViewStore().create()
    store.actions.setOrderBy('manual', {})
    store.actions.setGroupExpanded('workspace', false)
    const props = {
      wide: true, expandSidebar: vi.fn(), useSessions: hook(list([first, second])),
      useWorkspaces: hook(workspaces([workspaceView])), useStore: bindSnapshotSelector(store), actions: store.actions,
      startSession: vi.fn(), open: vi.fn(), searchSessions: vi.fn(async () => ({ items: [], hasMore: false })), searchResultLimit: 20,
      renameSession: vi.fn(async () => {}), forkSession: vi.fn(), renameWorkspace: vi.fn(async () => {}),
      deleteWorkspace: vi.fn(async () => {}), archiveSession: vi.fn(async () => {}),
      insertWorkspaceBefore: vi.fn(async () => {}), insertSessionBefore: vi.fn(async () => {}),
      createWorkspace: vi.fn(async () => workspace([])), useDirectoryFlow: bindSnapshotSelector(source(false)),
      useHostInfo: (selector: (x: { home: undefined; isLoopback: boolean }) => unknown) => selector({ home: undefined, isLoopback: true }),
      usePanelInfo: hook({ activePanelId: null }),
      useSessionPendingInteraction: hook(new Map()), renderSlot: vi.fn(), t: makeTranslate(zh, commonZh),
    } as unknown as WorkspaceBrowserProps
    render(<WorkspaceBrowser {...props} />)
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(screen.getByRole('treeitem', { name: 'Workspace' }))
    expect(screen.getAllByRole('treeitem').map(item => item.textContent)).toEqual([
      expect.stringContaining('Workspace'), expect.stringContaining('first'), expect.stringContaining('second'),
    ])
    expect(store.getSnapshot().sessionOrderByAccount.workspace).toEqual(['first', 'second'])
  })

  it('keeps excluded sessions in the flat account order', () => {
    const first = session('first')
    const second = session('second')
    const store = createWorkspaceViewStore().create()
    store.actions.setGroupBy('flat')
    store.actions.setOrderBy('manual', {})
    const view: WorkspaceListView = { id: 'second-only', order: 0, label: 'Second', include: ({ session: item }) => item.id === second.id }
    const props = {
      wide: true, expandSidebar: vi.fn(), useSessions: hook(list([first, second])),
      useWorkspaces: hook(workspaces([workspace(['first', 'second'])])), useStore: bindSnapshotSelector(store), actions: store.actions,
      startSession: vi.fn(), open: vi.fn(), searchSessions: vi.fn(async () => ({ items: [], hasMore: false })), searchResultLimit: 20,
      renameSession: vi.fn(async () => {}), forkSession: vi.fn(), renameWorkspace: vi.fn(async () => {}),
      deleteWorkspace: vi.fn(async () => {}),
      archiveSession: vi.fn(async () => {}), insertWorkspaceBefore: vi.fn(async () => {}), insertSessionBefore: vi.fn(async () => {}),
      createWorkspace: vi.fn(async () => workspace([])), useDirectoryFlow: bindSnapshotSelector(source(false)),
      useHostInfo: (selector: (x: { home: undefined; isLoopback: boolean }) => unknown) => selector({ home: undefined, isLoopback: true }),
      usePanelInfo: hook({ activePanelId: null }),
      useSessionPendingInteraction: hook(new Map()), renderSlot: vi.fn(), t: makeTranslate(zh, commonZh),
      useViews: hook([view]), usePolicies: hook([]),
    } as unknown as WorkspaceBrowserProps
    render(<WorkspaceBrowser {...props} />)
    expect(store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['first', 'second'])
    fireEvent.click(screen.getByRole('tab', { name: 'Second' }))
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.getByText('second')).toBeTruthy()
    expect(store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['first', 'second'])
  })

  it('orders valid filtered candidates and surfaces comparator failures', () => {
    const one = session('one')
    const two = session('two')
    const workspaceView = workspace(['stale', 'one', 'two'])
    const store = createWorkspaceViewStore().create()
    store.actions.setOrderBy('manual', {})
    const policy: WorkspaceListPolicy = {
      id: 'broken-comparator', order: 0,
      compare: (left, right) => {
        if (left.session.id === sid('two') && right.session.id === sid('one')) throw new Error('comparator failed')
        return 0
      },
    }
    const props = {
      wide: true, expandSidebar: vi.fn(), useSessions: hook(list([one, two])),
      useWorkspaces: hook(workspaces([workspaceView])), useStore: bindSnapshotSelector(store), actions: store.actions,
      startSession: vi.fn(), open: vi.fn(), searchSessions: vi.fn(async () => ({ items: [], hasMore: false })), searchResultLimit: 20,
      renameSession: vi.fn(async () => {}), forkSession: vi.fn(), renameWorkspace: vi.fn(async () => {}),
      deleteWorkspace: vi.fn(async () => {}), archiveSession: vi.fn(async () => {}),
      insertWorkspaceBefore: vi.fn(async () => {}), insertSessionBefore: vi.fn(async () => {}),
      createWorkspace: vi.fn(async () => workspace([])), useDirectoryFlow: bindSnapshotSelector(source(false)),
      useHostInfo: (selector: (x: { home: undefined; isLoopback: boolean }) => unknown) => selector({ home: undefined, isLoopback: true }),
      usePanelInfo: hook({ activePanelId: null }),
      useSessionPendingInteraction: hook(new Map()), renderSlot: vi.fn(), t: makeTranslate(zh, commonZh),
      useViews: hook([]), usePolicies: hook([policy]),
    } as unknown as WorkspaceBrowserProps
    const error = vi.spyOn(window.console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<WorkspaceBrowser {...props} />)).toThrow('comparator failed')
    } finally {
      error.mockRestore()
    }
  })

  it('surfaces contribution callback failures', () => {
    const view: WorkspaceListView = { id: 'broken', order: 0, label: 'Broken', include: () => { throw new Error('predicate failed') } }
    const store = createWorkspaceViewStore().create()
    const props = {
      wide: true, expandSidebar: vi.fn(), useSessions: hook(list([session('one')])),
      useWorkspaces: hook(workspaces([workspace(['one'])])), useStore: bindSnapshotSelector(store), actions: store.actions,
      startSession: vi.fn(), open: vi.fn(), searchSessions: vi.fn(async () => ({ items: [], hasMore: false })), searchResultLimit: 20,
      renameSession: vi.fn(async () => {}), forkSession: vi.fn(), renameWorkspace: vi.fn(async () => {}),
      deleteWorkspace: vi.fn(async () => {}),
      archiveSession: vi.fn(async () => {}), insertWorkspaceBefore: vi.fn(async () => {}), insertSessionBefore: vi.fn(async () => {}),
      createWorkspace: vi.fn(async () => workspace([])), useDirectoryFlow: bindSnapshotSelector(source(false)),
      useHostInfo: (selector: (x: { home: undefined; isLoopback: boolean }) => unknown) => selector({ home: undefined, isLoopback: true }),
      usePanelInfo: hook({ activePanelId: null }),
      useSessionPendingInteraction: hook(new Map()), renderSlot: vi.fn(), t: makeTranslate(zh, commonZh),
      useViews: hook([view]), usePolicies: hook([]),
    } as unknown as WorkspaceBrowserProps
    const error = vi.spyOn(window.console, 'error').mockImplementation(() => {})
    try {
      render(<WorkspaceBrowser {...props} />)
      expect(() => fireEvent.click(screen.getByRole('tab', { name: 'Broken' }))).toThrow('predicate failed')
    } finally {
      error.mockRestore()
    }
  })
})
