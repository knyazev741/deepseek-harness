/**
 * External-session transcript conversation nodes.
 *
 * External console agents (Codex, ACP clients) commit their durable activity
 * as standalone log-only `external/*` events (message-added, tool-activity,
 * permission-asked/decided, compaction-noticed, model-switched) — the same
 * vocabulary the host's session-projection unit folds into a transcript. Each
 * node matches one such event family, folds deterministically by seq, and
 * renders one Chat row — never scanning the full event window. Permission
 * asks pair with their matching decision by `askId`.
 */

import type { ConversationLocation, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode, ChatNodeKind } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One committed external message. */
    'external-message': ExternalMessageChatData
    /** One external tool activity (call/update/result). */
    'external-tool': ExternalToolChatData
    /** One external permission ask, with its decision once recorded. */
    'external-permission': ExternalPermissionChatData
    /** One external compaction notice. */
    'external-compaction': ExternalCompactionChatData
    /** One external model switch. */
    'external-model': ExternalModelChatData
  }
}

/** One committed external message row payload. */
export interface ExternalMessageChatData {
  readonly role: 'user' | 'agent'
  readonly text: string
}
/** One external tool activity row payload. */
export interface ExternalToolChatData {
  readonly kind: 'call' | 'update' | 'result'
  readonly title: string
  readonly detail?: string
}
/** One external permission ask row payload (decision once recorded). */
export interface ExternalPermissionChatData {
  readonly askId: string
  readonly title: string
  readonly options: readonly string[]
  readonly outcome?: 'allowed' | 'rejected' | 'cancelled'
}
/** One external compaction notice row payload. */
export interface ExternalCompactionChatData {
  readonly notice: string
}
/** One external model switch row payload. */
export interface ExternalModelChatData {
  readonly model: string
}

/** State for one permission ask + decision pair. */
interface PermissionState {
  readonly asked: { readonly askId: string; readonly title: string; readonly options: readonly string[] }
  readonly decided?: { readonly askId: string; readonly outcome: 'allowed' | 'rejected' | 'cancelled' }
}

/** The external event vocabulary field that node matchers read. */
type ExternalEventKind = 'external/message-added' | 'external/tool-activity' | 'external/permission-asked' | 'external/permission-decided' | 'external/compaction-noticed' | 'external/model-switched'

/** Structural shape of one external event used by the loose matchers. */
interface ExternalEvent {
  readonly type: ExternalEventKind
  readonly seq: number
  readonly data: {
    askId?: string
    role?: 'user' | 'agent'
    text?: string
    kind?: 'call' | 'update' | 'result'
    title?: string
    detail?: string
    notice?: string
    model?: string
    outcome?: 'allowed' | 'rejected' | 'cancelled'
    options?: readonly string[]
  }
}

const asExternal = (event: unknown): ExternalEvent | undefined =>
  typeof event === 'object' && event !== null ? event as ExternalEvent : undefined

/**
 * Resolve one Context's best currently loaded event Location.
 * @param context - assembled business Context.
 * @param firstMatch - the guard-verified primary Match of the Context.
 * @returns the start or first-match Location.
 */
function externalLocation(context: ConversationNodeContext, firstMatch: ConversationMatch): ConversationLocation {
  return context.start?.location ?? firstMatch.location
}

/**
 * Build one final Chat target Node with the engine-owned stable key.
 * @param context - assembled business Context.
 * @param firstMatch - the guard-verified primary Match of the Context.
 * @param kind - Chat renderer dispatch key.
 * @param anchorSeq - sortable render position.
 * @param data - renderer-owned payload.
 * @returns final Chat view Node.
 */
function externalChatNode<Kind extends ChatNodeKind>(
  context: ConversationNodeContext,
  firstMatch: ConversationMatch,
  kind: Kind,
  anchorSeq: number,
  data: ChatNode<Kind>['data'],
): ChatNode<Kind> {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: 'chat',
    anchorSeq,
    location: externalLocation(context, firstMatch),
    visibility: 'visible',
    data,
  } as unknown as ChatNode<Kind>
}

/** The external message row. Single-event business keyed by seq. */
export const externalMessageDefinition: ConversationNodeDefinition = {
  kind: 'external-message',
  target: 'chat',
  match: (event) => {
    const ext = asExternal(event)
    if (ext?.type !== 'external/message-added') return null
    return { id: `${ext.seq}`, role: 'update' }
  },
  start: () => ({}),
  update: () => ({}),
  buildViewNode: (context) => {
    const match = context.matches[0]
    if (match === undefined) return null
    const ext = asExternal(match.event)
    if (ext === undefined || ext.data.text === undefined || ext.data.role === undefined) return null
    return externalChatNode(context, match, 'external-message', match.event.seq, {
      role: ext.data.role,
      text: ext.data.text,
    })
  },
}

/** The external tool-activity row. Single-event business keyed by seq. */
export const externalToolDefinition: ConversationNodeDefinition = {
  kind: 'external-tool',
  target: 'chat',
  match: (event) => {
    const ext = asExternal(event)
    if (ext?.type !== 'external/tool-activity') return null
    return { id: `${ext.seq}`, role: 'update' }
  },
  start: () => ({}),
  update: () => ({}),
  buildViewNode: (context) => {
    const match = context.matches[0]
    if (match === undefined) return null
    const ext = asExternal(match.event)
    if (ext === undefined || ext.data.title === undefined) return null
    return externalChatNode(context, match, 'external-tool', match.event.seq, {
      kind: ext.data.kind ?? 'call',
      title: ext.data.title,
      ...ext.data.detail === undefined ? {} : { detail: ext.data.detail },
    })
  },
}

/** The external permission card, pairing ask and decision by askId. */
export const externalPermissionDefinition: ConversationNodeDefinition<PermissionState> = {
  kind: 'external-permission',
  target: 'chat',
  match: (event) => {
    const ext = asExternal(event)
    if (ext === undefined) return null
    if (ext.type === 'external/permission-asked') {
      if (typeof ext.data.askId !== 'string' || ext.data.askId === '') return null
      return { id: ext.data.askId, role: 'start' }
    }
    if (ext.type === 'external/permission-decided') {
      if (typeof ext.data.askId !== 'string' || ext.data.askId === '') return null
      return { id: ext.data.askId, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    const ext = asExternal(match.event)
    return {
      asked: {
        askId: ext?.data.askId ?? '',
        title: ext?.data.title ?? '',
        options: ext?.data.options ?? [],
      },
    }
  },
  update: (context, match) => {
    const ext = asExternal(match.event)
    if (ext === undefined || ext.type !== 'external/permission-decided' || ext.data.outcome === undefined) return context.state
    return { ...context.state, decided: { askId: ext.data.askId ?? '', outcome: ext.data.outcome } }
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const firstMatch = context.matches[0]
    if (firstMatch === undefined) return null
    return externalChatNode(context, firstMatch, 'external-permission', context.start?.event.seq ?? 0, {
      askId: state.asked.askId,
      title: state.asked.title,
      options: state.asked.options,
      ...state.decided === undefined ? {} : { outcome: state.decided.outcome },
    })
  },
}

/** The external compaction notice row. Single-event business keyed by seq. */
export const externalCompactionDefinition: ConversationNodeDefinition = {
  kind: 'external-compaction',
  target: 'chat',
  match: (event) => {
    const ext = asExternal(event)
    if (ext?.type !== 'external/compaction-noticed') return null
    return { id: `${ext.seq}`, role: 'update' }
  },
  start: () => ({}),
  update: () => ({}),
  buildViewNode: (context) => {
    const match = context.matches[0]
    if (match === undefined) return null
    const ext = asExternal(match.event)
    if (ext === undefined || ext.data.notice === undefined) return null
    return externalChatNode(context, match, 'external-compaction', match.event.seq, { notice: ext.data.notice })
  },
}

/** The external model-switch row. Single-event business keyed by seq. */
export const externalModelDefinition: ConversationNodeDefinition = {
  kind: 'external-model',
  target: 'chat',
  match: (event) => {
    const ext = asExternal(event)
    if (ext?.type !== 'external/model-switched') return null
    return { id: `${ext.seq}`, role: 'update' }
  },
  start: () => ({}),
  update: () => ({}),
  buildViewNode: (context) => {
    const match = context.matches[0]
    if (match === undefined) return null
    const ext = asExternal(match.event)
    if (ext === undefined || ext.data.model === undefined) return null
    return externalChatNode(context, match, 'external-model', match.event.seq, { model: ext.data.model })
  },
}
