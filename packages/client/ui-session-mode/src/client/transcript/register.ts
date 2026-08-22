/**
 * Register the external-session transcript business nodes and their chat rows.
 *
 * The Definitions ride `ctx.conversationEvents` (a runtime-provided service
 * ui-conversation consumes too); the renderers key `conversation.chat.node` by
 * the merged Chat renderer kind. Both are effect-scoped and HMR safe.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  externalCompactionDefinition,
  externalMessageDefinition,
  externalModelDefinition,
  externalPermissionDefinition,
  externalToolDefinition,
} from './external-transcript.ts'
import {
  ExternalCompactionRow,
  ExternalMessageRow,
  ExternalModelRow,
  ExternalPermissionRow,
  ExternalToolRow,
} from './external-nodes.tsx'

/** Register the five external transcript Definitions. */
export function registerExternalTranscriptNodes(ctx: Context): void {
  ctx.conversationEvents.register(externalMessageDefinition)
  ctx.conversationEvents.register(externalToolDefinition)
  ctx.conversationEvents.register(externalPermissionDefinition)
  ctx.conversationEvents.register(externalCompactionDefinition)
  ctx.conversationEvents.register(externalModelDefinition)
}

/** Register the external transcript chat row renderers. */
export function registerExternalTranscriptRenderers(ctx: Context): void {
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'external-message', locale: 'conversation' }, ExternalMessageRow))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'external-tool', locale: 'conversation' }, ExternalToolRow))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'external-permission', locale: 'conversation' }, ExternalPermissionRow))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'external-compaction', locale: 'conversation' }, ExternalCompactionRow))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'external-model', locale: 'conversation' }, ExternalModelRow))
}
