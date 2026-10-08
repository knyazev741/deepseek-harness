import { useState } from 'react'
import type { ReactElement } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace, HostObservable } from '@knyazevai/dsh-client-ui-slots'
import type { SessionSummary } from '@knyazevai/dsh-api-session-controller/client'
import { IconCopyOutlineRegular, MenuItemButton, writeClipboard } from '@knyazevai/dsh-client-ui-primitives'
import type { WorkspaceOverlaySnapshot } from './store.ts'
import { NS } from './locales.ts'
import css from './workspace-overlay.module.css'

/** Business face injected into each workspace row action entry. */
export interface WorkspaceRowActionsInjected {
  hooks: {
    overlay: HostObservable<WorkspaceOverlaySnapshot>
  }
  /** Mark the browser-local watermark immediately before the current sequence. */
  markUnread: (session: SessionSummary) => void

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
export function WorkspaceRowActions({ session, closeMenu, markUnread, t }: WorkspaceRowActionsProps): ReactElement {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'rejected'>('idle')
  const [feedback, setFeedback] = useState<string | undefined>()

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

  return (
    <span className={css.menuActions} data-overlay-session={String(session.id)}>
      <MenuItemButton
        icon={<IconCopyOutlineRegular size={14} />}
        onSelect={copy}
      >{t('copySessionId')}</MenuItemButton>
      <MenuItemButton
        icon={<span className={css.menuSymbol} aria-hidden="true">●</span>}
        onSelect={unread}
      >{t('markUnread')}</MenuItemButton>
      {copyState === 'rejected' || feedback !== undefined
        ? <span className={css.feedback} role="status" aria-live="polite">{feedback}</span>
        : null}
    </span>
  )
}
