import type { ClientContext, SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only assembly imports merge the public services and SlotMap contracts.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-fork-session-source/types'
import type {} from '@deepseek-ai/dsh-fork-workspace-session-state/remote'
import type { WorkspaceSessionRowContext } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createBackgroundView } from './BackgroundView.tsx'
import { WorkspaceRowActions, type PinMutationResult, type WorkspaceRowActionsInjected } from './WorkspaceRowActions.tsx'
import { WorkspaceRowBadges } from './WorkspaceRowBadges.tsx'
import { en, NS, zh, type WorkspaceOverlayLocaleKey } from './locales.ts'
import { createWorkspaceOverlayStore } from './store.ts'

export { NS, en, zh }
export type { WorkspaceOverlayLocaleKey } from './locales.ts'
export { createWorkspaceOverlayStore, lastSequenceOf, parseReadWatermarks, READ_WATERMARKS_STORAGE_KEY } from './store.ts'
export { isBackgroundSession, createBackgroundView } from './BackgroundView.tsx'
export { WorkspaceRowActions, type WorkspaceRowActionsInjected, type WorkspaceRowActionsProps, type PinMutationResult } from './WorkspaceRowActions.tsx'
export { WorkspaceRowBadges, type WorkspaceRowBadgesProps } from './WorkspaceRowBadges.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
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

/** Apply the fork-owned Workspace view, ordering policy, and row controls. */
export function apply(ctx: ClientContext): void {
  const store = createWorkspaceOverlayStore()
  const t = ctx.locale.bind(NS)
  const contributions = ctx.workspaceContributions

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fork-ui-workspace-overlay: dictionaries')

  // The server snapshot is authoritative. Initial loading and conflict refresh
  // update this separate pin compartment; no browser-local write is involved.
  const refreshPins = async (): Promise<void> => {
    const result = await ctx.remote.forkWorkspaceSessionState.list()
    if (result.ok) store.installPins(result.value)
  }
  ctx.effect(() => {
    void refreshPins().catch(() => {
      // A disconnected Host leaves the empty pin view; the next explicit pin
      // action observes revision zero and reports the Host result to the row.
    })
    return () => {}
  }, 'fork-ui-workspace-overlay: initial pin snapshot')

  ctx.effect(() => () => { store.dispose() }, 'fork-ui-workspace-overlay: store')

  ctx.effect(() => {
    let previous: SessionId | undefined
    const syncCurrentRead = (): void => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const current = snapshot.current
      if (current !== undefined && current !== previous) {
        const summary = sessionFrom(snapshot, current)
        if (summary !== undefined) store.markRead(summary)
      }
      previous = current
    }
    syncCurrentRead()
    return ctx.sessions.list.subscribe(syncCurrentRead)
  }, 'fork-ui-workspace-overlay: current-session read watermark')

  const setPinned = async (session: SessionSummary, pinned: boolean): Promise<PinMutationResult> => {
    const result = await ctx.remote.forkWorkspaceSessionState.setPinned({
      sessionId: session.id,
      pinned,
      expectedRevision: store.observedPinRevision(),
    })
    if (!result.ok) return { accepted: false }
    if (result.value.ok) {
      store.installPins(result.value.value)
      return { accepted: true }
    }
    if (result.value.error.code === 'revision-conflict') {
      // Refresh once after a stale CAS. Deliberately do not replay the write;
      // a second click is the explicit user acknowledgement of new state.
      const refreshed = await ctx.remote.forkWorkspaceSessionState.list()
      if (refreshed.ok) store.installPins(refreshed.value)
      return { accepted: false, stale: true }
    }
    return { accepted: false }
  }

  const actions = (action: WorkspaceRowActionsInjected['action']): WorkspaceRowActionsInjected => ({
    action,
    hooks: { overlay: store },
    markUnread: (session) => { store.markUnread(session) },
    setPinned,
  })

  ctx.effect(() => contributions.registerView(createBackgroundView(t)), 'fork-ui-workspace-overlay: Background view')
  const pinPolicy = {
    id: 'fork.pinned-first',
    order: 100,
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
    id: 'fork.copy-session-id',
    order: 100,
    locale: NS,
    inject: () => actions('copy-session-id'),
  }, WorkspaceRowActions))

  // The slot ledger has one cell per action id, so the three user-facing verbs
  // share one visual component while keeping distinct registration identities.
  ctx.slots.inject('workspace.session-row.actions', () => ctx.slots.register({
    name: 'workspace.session-row.actions',
    id: 'fork.mark-unread',
    order: 101,
    locale: NS,
    inject: () => actions('mark-unread'),
  }, WorkspaceRowActions))

  ctx.slots.inject('workspace.session-row.actions', () => ctx.slots.register({
    name: 'workspace.session-row.actions',
    id: 'fork.pin-session',
    order: 102,
    locale: NS,
    inject: () => actions('pin-session'),
  }, WorkspaceRowActions))
}
