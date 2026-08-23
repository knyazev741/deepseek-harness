import { useState } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, IconCopyOutline16, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceOverlaySnapshot } from './store.ts'
import { NS } from './locales.ts'
import css from './workspace-overlay.module.css'

/** Result returned after one explicit pin/unpin click. */
export interface PinMutationResult {
  /** Host accepted the requested state. */
  readonly accepted: boolean
  /** Host rejected an obsolete revision; no mutation retry was attempted. */
  readonly stale?: boolean
}

/** Business face injected into each workspace row action entry. */
export interface WorkspaceRowActionsInjected {
  /** One of the three independently registered row verbs. */
  action: 'copy-session-id' | 'mark-unread' | 'pin-session'
  hooks: {
    overlay: HostObservable<WorkspaceOverlaySnapshot>
  }
  /** Mark the browser-local watermark immediately before the current sequence. */
  markUnread: (session: SessionSummary) => void
  /** Send one CAS pin/unpin request, with conflict refresh but no mutation retry. */
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
export function WorkspaceRowActions({ session, action, useOverlay, markUnread, setPinned, t }: WorkspaceRowActionsProps): JSX.Element {
  const pinned = useOverlay(snapshot => snapshot.pins?.pinnedSessionIds.includes(session.id) ?? false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'rejected'>('idle')
  const [feedback, setFeedback] = useState<string | undefined>()
  const [pending, setPending] = useState(false)

  const copy = (): void => {
    void writeClipboard(String(session.id)).then((accepted) => {
      setCopyState(accepted ? 'copied' : 'rejected')
      setFeedback(accepted ? t('copiedSessionId') : t('clipboardRejected'))
    })
  }
  const unread = (): void => {
    markUnread(session)
    setFeedback(t('markedUnread'))
  }
  const togglePin = (): void => {
    if (pending) return
    setPending(true)
    void setPinned(session, !pinned).then((result) => {
      setPending(false)
      if (result.accepted) setFeedback(!pinned ? t('pin') : t('unpin'))
      else if (result.stale) setFeedback(t('pinConflict'))
    }, () => {
      setPending(false)
    })
  }

  return (
    <span className={css.actions} data-overlay-session={String(session.id)}>
      {action === 'copy-session-id' && <Button
        size="sm"
        variant="toolbar"
        className={css.action}
        icon={<IconCopyOutline16 size={14} />}
        aria-label={t('copySessionIdAria')}
        onClick={(event) => { event.stopPropagation(); copy() }}
      >
        <span className={css.visuallyHidden}>{t('copySessionId')}</span>
      </Button>}
      {action === 'mark-unread' && <Button
        size="sm"
        variant="toolbar"
        className={css.action}
        aria-label={t('markUnread')}
        onClick={(event) => { event.stopPropagation(); unread() }}
      >
        <span className={css.actionText}>●</span>
        <span className={css.visuallyHidden}>{t('markUnread')}</span>
      </Button>}
      {action === 'pin-session' && <Button
        size="sm"
        variant="toolbar"
        className={css.action}
        aria-label={t(pinned ? 'unpinSessionAria' : 'pinSessionAria')}
        aria-pressed={pinned}
        disabled={pending}
        onClick={(event) => { event.stopPropagation(); togglePin() }}
      >
        <span className={css.actionText}>{pinned ? '★' : '☆'}</span>
        <span className={css.visuallyHidden}>{t(pinned ? 'unpin' : 'pin')}</span>
      </Button>}
      {copyState === 'rejected' || feedback !== undefined
        ? <span className={css.feedback} role="status" aria-live="polite">{feedback}</span>
        : null}
    </span>
  )
}
