// @vitest-environment jsdom
/**
 * The transcript registration mounts every external node definition through
 * `conversationEvents.register` and every row through a keyed
 * `conversation.chat.node` slot registration matching a renderer kind. A fake
 * runtime captures both streams so the affordance stays typed and complete.
 */

import { describe, expect, it, vi } from 'vitest'
import { registerExternalTranscriptNodes, registerExternalTranscriptRenderers } from '../src/client/transcript/register.ts'

interface RegisterMeta {
  name: string
  key?: string
  id?: string
  locale: string
}

describe('external transcript registration', () => {
  it('registers all five definitions through conversationEvents', () => {
    const definitions: string[] = []
    const ctx = {
      conversationEvents: {
        register: (definition: { kind: string }) => { definitions.push(definition.kind) },
      },
      slots: { inject: vi.fn(), register: vi.fn() },
    } as never
    registerExternalTranscriptNodes(ctx)
    expect(definitions.sort()).toEqual([
      'external-compaction', 'external-message', 'external-model',
      'external-permission', 'external-tool',
    ])
  })

  it('registers five durable rows and one transient live seat', () => {
    const metas: RegisterMeta[] = []
    const liveMetas: RegisterMeta[] = []
    let activeSlot: string | undefined
    const ctx = {
      conversationEvents: { register: vi.fn() },
      slots: {
        inject: (slot: string, cb: () => unknown) => { activeSlot = slot; cb(); activeSlot = undefined },
        register: (meta: RegisterMeta) => { (activeSlot === 'conversation.chat.live' ? liveMetas : metas).push(meta) },
      },
    } as never
    registerExternalTranscriptRenderers(ctx)
    expect(metas.map(meta => meta.key).sort()).toEqual([
      'external-compaction', 'external-message', 'external-model',
      'external-permission', 'external-tool',
    ])
    for (const meta of metas) {
      expect(meta.name).toBe('conversation.chat.node')
      expect(meta.locale).toBe('conversation')
    }
    expect(liveMetas).toHaveLength(1)
    expect(liveMetas[0]?.name).toBe('conversation.chat.live')
    expect(liveMetas[0]?.id).toBe('external-live')
  })
})
