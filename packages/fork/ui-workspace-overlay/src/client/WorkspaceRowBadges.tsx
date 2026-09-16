import type * as React from 'react'
import type { PropsLocale, PropsRuntime } from '@knyazevai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type { WorkspaceSessionRowContext } from '@knyazevai/dsh-client-ui-workspace/client'
import css from './workspace-overlay.module.css'

/** Component props supplied by the workspace row badge slot. */
export type WorkspaceRowBadgesProps = PropsRuntime<'workspace.session-row.badges'> & PropsLocale<typeof NS>

/** Render the source badge only for the exact GitHub Actions projection value. */
export function WorkspaceRowBadges({ session, t }: WorkspaceRowBadgesProps): React.JSX.Element | null {
  const source = (session.projectionValues as Readonly<Record<string, unknown>> | undefined)?.forkSessionSource
  if (source !== 'github-actions') return null
  return (
    <span className={css.badge} aria-label={t('githubActions')} data-fork-session-source="github-actions">
      {t('githubActions')}
    </span>
  )
}

// Keep the public owner context visible to package consumers without widening
// the component props beyond the SlotMap-derived contract.
export type { WorkspaceSessionRowContext }
