/** Fork workspace-overlay dictionaries. */

/** Locale namespace registered by the client plugin. */
export const NS = 'fork.workspaceOverlay' as const

/** Simplified Chinese copy is the locale key source of truth. */
export const zh = {
  background: '后台',
  copySessionId: '复制会话 ID',
  copySessionIdAria: '复制会话 ID',
  copiedSessionId: '已复制会话 ID',
  clipboardRejected: '无法访问剪贴板',
  pinConflict: '置顶状态已更新，请再次点击',
  markUnread: '标为未读',
  markedUnread: '已标为未读',
  pin: '置顶',
  unpin: '取消置顶',
  pinSessionAria: '置顶会话',
  unpinSessionAria: '取消置顶会话',
  githubActions: 'GitHub Actions',
} satisfies Record<string, string>

/** Locale key union. */
export type WorkspaceOverlayLocaleKey = keyof typeof zh

/** English dictionary, kept complete with the Chinese key set. */
export const en = {
  background: 'Background',
  copySessionId: 'Copy session ID',
  copySessionIdAria: 'Copy session ID',
  copiedSessionId: 'Session ID copied',
  clipboardRejected: 'Clipboard access was denied',
  pinConflict: 'Pin state changed; click again to apply',
  markUnread: 'Mark unread',
  markedUnread: 'Marked unread',
  pin: 'Pin',
  unpin: 'Unpin',
  pinSessionAria: 'Pin session',
  unpinSessionAria: 'Unpin session',
  githubActions: 'GitHub Actions',
} satisfies Record<WorkspaceOverlayLocaleKey, string>
