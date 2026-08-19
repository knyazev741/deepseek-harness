/**
 * ui-session-mode apply: one apply registers the hero mode picker plus its
 * locale and controller, waiting on the conversation declaration. The staged
 * mode + model ride `session.create` itself, and the picker reads the catalog
 * from `session.externalModes`.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-session-mode/client'
import { ModePicker, type ModePickerInjected } from '../src/client/ModePicker.tsx'
import type { ExternalModeGroup } from '@deepseek-ai/dsh-api-remotes/client'

/** A catalog the fake api mutates between loads. */
const CATALOG: ExternalModeGroup[] = [
  { provider: 'codex', label: 'Codex', modelDirectory: 'config', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
]

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  new TestRemote(ctx)
  const creates: { mode?: string; model?: string; workspaceId?: string }[] = []
  const externalModesCalls: string[] = []
  let createFail: string | undefined
  ctx.provide('connection', {
    api: {
      sessions: {
        externalModes: () => {
          externalModesCalls.push('externalModes')
          return Promise.resolve({
            rpcId: 'r',
            result: { ok: true as const, value: { groups: CATALOG, failures: [] } },
          })
        },
        create: (payload: { workspaceId?: string; mode?: string; model?: string }) => {
          creates.push(payload)
          return createFail === undefined
            ? Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { sessionId: 's1' } } })
            : Promise.resolve({
              rpcId: 'r',
              result: { ok: false as const, error: { code: 'internal', message: createFail, details: {} } },
            })
        },
      },
    },
  } as never)
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, creates, externalModesCalls,
    failCreate: (message: string) => { createFail = message },
  }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { conversation: { kind: 'single', scope: 'root' } },
  } as never, () => null)
}

/** The conversation's own declaration, which the hero picker waits for. */
function declareConversation(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'conversation',
    children: { 'conversation.hero.sessionMode': { kind: 'single', scope: 'root' } },
  } as never, () => null)
}

/** The sessions face the apply's hero flow reads for the current workspace. */
function sessionsDouble(state: { current?: string }) {
  let current = state.current
  return {
    list: { getSnapshot: () => ({ current }) },
    setCurrent: (value: string | undefined) => { current = value },
  }
}

/** The workspaces face carrying the workspace each current session sits in. */
function workspacesDouble(state: { items: { workspaceId: string; sessionIds: string[] }[]; recentWorkspaceId?: string }) {
  return {
    list: { getSnapshot: () => state },
  }
}

describe('ui-session-mode apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'sessions', 'workspaces', 'remote'])
  })

  it('registers the hero picker and submits creation carrying the staged mode + model', async () => {
    const { ctx, slots, creates, externalModesCalls } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const sessions = sessionsDouble({ current: 's9' })
    ctx.provide('sessions', sessions as never)
    const workspaces = workspacesDouble({
      items: [{ workspaceId: 'w1', sessionIds: ['s9'] }],
      recentWorkspaceId: 'w0',
    })
    ctx.provide('workspaces', workspaces as never)
    await ctx.plugin({ inject: [...inject, 'conversation'], apply }).await()

    const seat = slots.entries('conversation.hero.sessionMode')[0]!
    expect(seat.component).toBe(ModePicker)

    // The picker is a props-driven surface; the registration-side face gives
    // it its store and callbacks. `load` reads the catalog once.
    const face = (seat.inject as unknown as () => ModePickerInjected)()
    await face.load()
    expect(externalModesCalls).toHaveLength(1)
    expect(face.hooks.modeSeat.getSnapshot().modes).toHaveLength(1)
    expect(face.hooks.modeSeat.getSnapshot().modes[0]).toMatchObject({ provider: 'codex', hasModels: true })

    // Stage a mode + model; creation rides session.create with both, targeting
    // the workspace of the current session.
    face.select('codex')
    face.selectModel('gpt-5')
    await face.create()

    expect(creates).toEqual([{ workspaceId: 'w1', mode: 'codex', model: 'gpt-5' }])
  })

  it('submits creation without a workspace when no session is current, and without a model', async () => {
    const { ctx, slots, creates } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({}) as never)
    ctx.provide('workspaces', workspacesDouble({ items: [], recentWorkspaceId: 'w0' }) as never)
    await ctx.plugin({ inject: [...inject, 'conversation'], apply }).await()

    const face = (slots.entries('conversation.hero.sessionMode')[0]!.inject as unknown as () => ModePickerInjected)()
    await face.load()
    face.select('codex')
    await face.create()

    // No current session, and no model staged: creation carries only the mode.
    expect(creates).toEqual([{ mode: 'codex' }])
  })

  it('falls back to the recent workspace for a current session not in any list', async () => {
    const { ctx, slots, creates } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    // 's9' is current but absent from every workspace's sessionIds.
    ctx.provide('sessions', sessionsDouble({ current: 's9' }) as never)
    ctx.provide('workspaces', workspacesDouble({ items: [{ workspaceId: 'w2', sessionIds: ['s8'] }], recentWorkspaceId: 'w0' }) as never)
    await ctx.plugin({ inject: [...inject, 'conversation'], apply }).await()

    const face = (slots.entries('conversation.hero.sessionMode')[0]!.inject as unknown as () => ModePickerInjected)()
    await face.load()
    face.select('codex')
    await face.create()

    expect(creates).toEqual([{ workspaceId: 'w0', mode: 'codex' }])
  })

  it('surfaces a refused create to the picker', async () => {
    const { ctx, slots, failCreate } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({ current: 's9' }) as never)
    ctx.provide('workspaces', workspacesDouble({ items: [{ workspaceId: 'w1', sessionIds: ['s9'] }], recentWorkspaceId: 'w0' }) as never)
    await ctx.plugin({ inject: [...inject, 'conversation'], apply }).await()

    const face = (slots.entries('conversation.hero.sessionMode')[0]!.inject as unknown as () => ModePickerInjected)()
    await face.load()
    face.select('codex')
    failCreate('creation refused')
    await face.create()

    expect(face.hooks.modeSeat.getSnapshot().error).toBe('creation refused')
  })

  it('drops the hero picker on fiber disposal', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({}) as never)
    ctx.provide('workspaces', workspacesDouble({ items: [], recentWorkspaceId: 'w0' }) as never)
    const fiber = ctx.plugin({ inject: [...inject, 'conversation'], apply })
    await fiber.await()

    expect(slots.entries('conversation.hero.sessionMode')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('conversation.hero.sessionMode')).toHaveLength(0)
  })
})
