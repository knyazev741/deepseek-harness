/**
 * Register the external-session transcript business nodes and their chat rows.
 *
 * The Definitions ride `ctx.conversationEvents` (a runtime-provided service
 * ui-conversation consumes too); the renderers key `conversation.chat.node` by
 * the merged Chat renderer kind and add one transient live seat. Both
 * registrations are effect-scoped and HMR safe.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  externalCompactionDefinition,
  externalMessageDefinition,
  externalModelDefinition,
  externalPermissionDefinition,
  externalSessionFailureDefinition,
  externalToolDefinition,
} from './external-transcript.ts'
import {
  ExternalCompactionRow,
  ExternalLiveSeat,
  ExternalMessageRow,
  ExternalModelRow,
  ExternalPermissionRow,
  ExternalSessionFailureRow,
  ExternalToolRow,
} from './external-nodes.tsx'

/**
 * Register the six external transcript Definitions.
 * @param ctx - client context owning the conversation event registry.
 */
export function registerExternalTranscriptNodes(ctx: Context): void {
  ctx.conversationEvents.register(externalMessageDefinition)
  ctx.conversationEvents.register(externalToolDefinition)
  ctx.conversationEvents.register(externalPermissionDefinition)
  ctx.conversationEvents.register(externalCompactionDefinition)
  ctx.conversationEvents.register(externalModelDefinition)
  ctx.conversationEvents.register(externalSessionFailureDefinition)
}

/**
 * Register the external transcript chat row renderers.
 * @param ctx - client context owning the slot registry.
 */
export function registerExternalTranscriptRenderers(ctx: Context): void {
  ctx.slots.inject('conversation.chat.live', () => ctx.slots.register(
    { name: 'conversation.chat.live', id: 'external-live', locale: 'conversation' }, ExternalLiveSeat))
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
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'external-session-failure', locale: 'conversation' }, ExternalSessionFailureRow))
}
