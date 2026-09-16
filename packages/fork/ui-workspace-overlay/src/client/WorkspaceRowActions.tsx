import { useState } from 'react'
import type { ReactElement } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace, HostObservable } from '@knyazevai/dsh-client-ui-slots'
import type { SessionSummary } from '@knyazevai/dsh-api-session-controller/client'
import { IconCopyOutline16, IconPushpinOutline16, MenuItemButton, writeClipboard } from '@knyazevai/dsh-client-ui-primitives'
import type { WorkspaceOverlaySnapshot } from './store.ts'
import { NS } from './locales.ts'
import css from './workspace-overlay.module.css'

/** Result returned after one explicit pin/unpin click. */
export interface PinMutationResult {
  /** Host accepted the requested state. */
  readonly accepted: boolean
  /** The refreshed retry also lost a revision race. */
  readonly stale?: boolean
}

/** Business face injected into each workspace row action entry. */
export interface WorkspaceRowActionsInjected {
  hooks: {
    overlay: HostObservable<WorkspaceOverlaySnapshot>
  }
  /** Mark the browser-local watermark immediately before the current sequence. */
  markUnread: (session: SessionSummary) => void
  /** Send a CAS pin/unpin request, refreshing and retrying one stale revision. */
  setPinned: (session: SessionSummary, pinned: boolean) => Promise<PinMutationResult>
}

/** Full props for the workspace row actions slot. */
export type WorkspaceRowActionsProps =
  PropsRuntime<'workspace.session-row.actions'>
  & InjectFace<WorkspaceRowActionsInjected>
  & PropsLocale<typeof NS>

/**
 * Render copy, unread, and pin controls for one non-blank workspace session.
 * @param props - row context, injected actions, and locale seat.
 * @returns action buttons and accessible feedback.
 */
export function WorkspaceRowActions({ session, closeMenu, useOverlay, markUnread, setPinned, t }: WorkspaceRowActionsProps): ReactElement {
  const pinned = useOverlay(snapshot => snapshot.pins?.pinnedSessionIds.includes(session.id) ?? false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'rejected'>('idle')
  const [feedback, setFeedback] = useState<string | undefined>()
  const [pending, setPending] = useState(false)

  const copy = (): void => {
    void writeClipboard(String(session.id)).then((accepted) => {
      setCopyState(accepted ? 'copied' : 'rejected')
      setFeedback(accepted ? t('copiedSessionId') : t('clipboardRejected'))
      if (accepted) closeMenu()
    })
  }
  const unread = (): void => {
    markUnread(session)
    setFeedback(t('markedUnread'))
    closeMenu()
  }
  const togglePin = (): void => {
    if (pending) return
    setPending(true)
    void setPinned(session, !pinned).then((result) => {
      setPending(false)
      if (result.accepted) {
        setFeedback(!pinned ? t('pin') : t('unpin'))
        closeMenu()
      }
      else if (result.stale) setFeedback(t('pinConflict'))
    }, () => {
      setPending(false)
    })
  }

  return (
    <span className={css.menuActions} data-overlay-session={String(session.id)}>
      <MenuItemButton
        icon={<IconCopyOutline16 size={14} />}
        label={t('copySessionId')}
        onClick={copy}
      />
      <MenuItemButton
        icon={<span className={css.menuSymbol}>●</span>}
        label={t('markUnread')}
        onClick={unread}
      />
      <MenuItemButton
        icon={<IconPushpinOutline16 size={14} />}
        label={t(pinned ? 'unpinSessionAria' : 'pinSessionAria')}
        disabled={pending}
        pressed={pinned}
        onClick={togglePin}
      />
      {copyState === 'rejected' || feedback !== undefined
        ? <span className={css.feedback} role="status" aria-live="polite">{feedback}</span>
        : null}
    </span>
  )
}
