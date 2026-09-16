import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@knyazevai/dsh-session/types'
import type { SessionSummary } from '@knyazevai/dsh-api-session-controller/client'
// Type-only assembly imports merge the public services and SlotMap contracts.
import type {} from '@knyazevai/dsh-api-remotes/client'
import type {} from '@knyazevai/dsh-client-locale/client'
import type {} from '@knyazevai/dsh-client-ui-renderer/client'
import type {} from '@knyazevai/dsh-client-ui-workspace/client'
import type {} from '@knyazevai/dsh-fork-session-source/types'
import type {} from '@knyazevai/dsh-fork-workspace-session-state/remote'
import type { WorkspaceSessionRowContext } from '@knyazevai/dsh-client-ui-workspace/client'
import { WorkspaceRowActions, type PinMutationResult, type WorkspaceRowActionsInjected } from './WorkspaceRowActions.tsx'
import { WorkspaceRowStatus } from './WorkspaceRowStatus.tsx'
import { WorkspaceRowBadges } from './WorkspaceRowBadges.tsx'
import { en, NS, zh, type WorkspaceOverlayLocaleKey } from './locales.ts'
import { createWorkspaceOverlayStore } from './store.ts'

export { NS }
export type { WorkspaceOverlayLocaleKey } from './locales.ts'

declare module '@knyazevai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Fork-owned Workspace overlay copy. */
    [NS]: WorkspaceOverlayLocaleKey
  }
}

/** Services and contribution registries required by the overlay. */
export const inject = [
  'slots', 'sessions', 'workspaceContributions', 'remote', 'remote.forkWorkspaceSessionState', 'locale',
] as const

function sessionFrom(
  summaries: ReturnType<ClientContext['sessions']['list']['getSnapshot']>,
  sessionId: SessionId,
): SessionSummary | undefined {
  return summaries.byId[sessionId]
}

/** Apply the fork-owned Workspace ordering policy, and row controls. */
export function apply(ctx: ClientContext): void {
  const store = createWorkspaceOverlayStore()
  const contributions = ctx.workspaceContributions
  const lifecycle = { disposed: false }
  const isDisposed = (): boolean => lifecycle.disposed

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fork-ui-workspace-overlay: dictionaries')

  // The server snapshot is authoritative. Initial loading and conflict refresh
  // update this separate pin compartment; no browser-local write is involved.
  ctx.effect(() => {
    let cancelled = false
    void ctx.remote.forkWorkspaceSessionState.list().then((result) => {
      if (cancelled || lifecycle.disposed) return
      if (result.ok) store.installPins(result.value)
    }).catch(() => {
      // A disconnected Host leaves the empty pin view; the next explicit pin
      // action observes revision zero and reports the Host result to the row.
    })
    return () => { cancelled = true }
  }, 'fork-ui-workspace-overlay: initial pin snapshot')

  ctx.effect(() => () => { lifecycle.disposed = true; store.dispose() }, 'fork-ui-workspace-overlay: store')

  ctx.effect(() => {
    let previous: SessionId | undefined
    const syncCurrentRead = (): void => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const current = snapshot.current
      if (current !== undefined) {
        const summary = sessionFrom(snapshot, current)
        if (summary !== undefined) {
          if (current === previous) store.observeRead(summary)
          else store.markRead(summary)
        }
      }
      previous = current
    }
    syncCurrentRead()
    return ctx.sessions.list.subscribe(syncCurrentRead)
  }, 'fork-ui-workspace-overlay: current-session read watermark')

  const setPinned = async (session: SessionSummary, pinned: boolean): Promise<PinMutationResult> => {
    if (isDisposed()) return { accepted: false }
    const result = await ctx.remote.forkWorkspaceSessionState.setPinned({
      sessionId: session.id,
      pinned,
      expectedRevision: store.observedPinRevision(),
    })
    if (isDisposed()) return { accepted: false }
    if (!result.ok) return { accepted: false }
    if (result.value.ok) {
      store.installPins(result.value.value)
      return { accepted: true }
    }
    if (result.value.error.code === 'revision-conflict') {
      // A browser tab can retain the previous Settings revision across a Host
      // restart (or lose the initial list race). Refresh and replay this one
      // explicit intent so a normal click is not converted into a no-op.
      const refreshed = await ctx.remote.forkWorkspaceSessionState.list()
      if (isDisposed() || !refreshed.ok) return { accepted: false }
      store.replacePins(refreshed.value)
      const retry = await ctx.remote.forkWorkspaceSessionState.setPinned({
        sessionId: session.id,
        pinned,
        expectedRevision: store.observedPinRevision(),
      })
      if (isDisposed()) return { accepted: false }
      if (!retry.ok) return { accepted: false }
      if (retry.value.ok) {
        store.installPins(retry.value.value)
        return { accepted: true }
      }
      return { accepted: false, stale: retry.value.error.code === 'revision-conflict' }
    }
    return { accepted: false }
  }

  const actions = (): WorkspaceRowActionsInjected => ({
    hooks: { overlay: store },
    markUnread: (session) => { store.markUnread(session) },
    setPinned,
  })

  const pinPolicy = {
    id: 'fork.pinned-first',
    order: 100,
    promote: (context: WorkspaceSessionRowContext): boolean => store.isPinned(context.session.id),
    compare: (left: WorkspaceSessionRowContext, right: WorkspaceSessionRowContext): number => {
      const leftPinned = store.isPinned(left.session.id)
      const rightPinned = store.isPinned(right.session.id)
      if (leftPinned === rightPinned) return 0
      return leftPinned ? -1 : 1
    },
  }
  ctx.effect(() => {
    // The upstream contribution source publishes registration changes, not
    // arbitrary policy-state changes. Re-registering this one policy on pin
    // updates gives WorkspaceBrowser a new policies snapshot and therefore
    // recomputes the order without mutating the upstream session list.
    let dispose = contributions.registerPolicy(pinPolicy)
    let previousPins = store.getSnapshot().pins
    const unsubscribe = store.subscribe(() => {
      const nextPins = store.getSnapshot().pins
      if (nextPins === previousPins) return
      previousPins = nextPins
      dispose()
      dispose = contributions.registerPolicy(pinPolicy)
    })
    return () => {
      unsubscribe()
      dispose()
    }
  }, 'fork-ui-workspace-overlay: pin ordering')

  ctx.slots.inject('workspace.session-row.badges', () => ctx.slots.register({
    name: 'workspace.session-row.badges',
    id: 'fork.github-actions-source',
    order: 100,
    locale: NS,
  }, WorkspaceRowBadges))

  ctx.slots.inject('workspace.session-row.actions', () => ctx.slots.register({
    name: 'workspace.session-row.actions',
    id: 'fork.session-menu-actions',
    order: 100,
    locale: NS,
    inject: () => actions(),
  }, WorkspaceRowActions))

  ctx.slots.inject('workspace.session-row.status', () => ctx.slots.register({
    name: 'workspace.session-row.status',
    id: 'fork.session-unread-status',
    order: 100,
    locale: NS,
    inject: () => ({ hooks: { overlay: store } }),
  }, WorkspaceRowStatus))
}
