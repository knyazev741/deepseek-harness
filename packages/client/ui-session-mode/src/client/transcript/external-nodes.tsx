/**
 * External-session transcript chat rows.
 *
 * Each keyed `conversation.chat.node` renderer draws one durable
 * `external/*` row from its frozen node payload. The message row carries the
 * committed user/agent text; the tool row the activity phase and title; the
 * permission card the ask's options and, once recorded, its outcome; the
 * compaction/model rows their one-line notices. Safe to route through
 * replay because every datum comes from the node payload, never the window.
 */

import { memo } from 'react'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './transcript.module.css'

/** Outcome copy keyed by the durable decision. */
const PERMISSION_OUTCOME_TEXT: Record<'allowed' | 'rejected' | 'cancelled', string> = {
  allowed: '允许',
  rejected: '拒绝',
  cancelled: '已取消',
}

/** One committed external message row. */
export const ExternalMessageRow = memo(function ExternalMessageRow({ node }: ChatNodeViewProps<'external-message'>) {
  const data = node.data
  return (
    <div className={css.messageRow} data-role={data.role}>
      <span className={css.kicker}>{data.role === 'user' ? '你' : '智能体'}</span>
      <span className={css.body}>{data.text}</span>
    </div>
  )
})

/** One external tool activity row. */
export const ExternalToolRow = memo(function ExternalToolRow({ node }: ChatNodeViewProps<'external-tool'>) {
  const data = node.data
  return (
    <div className={css.toolRow} data-kind={data.kind}>
      <span className={css.kicker}>工具 · {data.kind}</span>
      <span className={css.body}>{data.title}</span>
      {data.detail !== undefined && <span className={css.detail}>{data.detail}</span>}
    </div>
  )
})

/** One external permission ask card, with its outcome once decided. */
export const ExternalPermissionRow = memo(function ExternalPermissionRow({ node }: ChatNodeViewProps<'external-permission'>) {
  const data = node.data
  return (
    <div className={css.permissionRow}>
      <span className={css.kicker}>权限</span>
      <span className={css.body}>{data.title}</span>
      <ul className={css.options}>
        {data.options.map(option => <li key={option} className={css.option}>{option}</li>)}
      </ul>
      {data.outcome === undefined
        ? <span className={css.pending}>等待决策…</span>
        : <span className={css.outcome} data-outcome={data.outcome}>{PERMISSION_OUTCOME_TEXT[data.outcome]}</span>}
    </div>
  )
})

/** One external compaction notice row. */
export const ExternalCompactionRow = memo(function ExternalCompactionRow({ node }: ChatNodeViewProps<'external-compaction'>) {
  return (
    <div className={css.noticeRow}>
      <span className={css.kicker}>压缩</span>
      <span className={css.body}>{node.data.notice}</span>
    </div>
  )
})

/** One external model-switch row. */
export const ExternalModelRow = memo(function ExternalModelRow({ node }: ChatNodeViewProps<'external-model'>) {
  return (
    <div className={css.noticeRow}>
      <span className={css.kicker}>模型</span>
      <span className={css.body}>{node.data.model}</span>
    </div>
  )
})
