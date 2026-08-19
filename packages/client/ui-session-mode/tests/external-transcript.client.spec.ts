/**
 * The external transcript Definitions fold each durable `external/*` event
 * family deterministically by seq into one Chat node. These specs drive
 * match → start/update → buildViewNode directly on scripted events and assert
 * the produced node — the same fold replay uses, so replay and live streaming
 * render identically.
 */

import { describe, expect, it } from 'vitest'
import type { ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  externalCompactionDefinition,
  externalMessageDefinition,
  externalModelDefinition,
  externalPermissionDefinition,
  externalToolDefinition,
} from '../src/client/transcript/external-transcript.ts'

/** One raw external session event. */
function event(type: string, seq: number, data: Record<string, unknown>) {
  return { type, seq, data } as never
}

/** A context carrying the given scripted matches, plus optional state. */
function context(
  matches: { event: unknown; role: 'start' | 'update' }[],
  state?: unknown,
): ConversationNodeContext {
  const resolved = matches.map(({ event, role }, index) => ({
    event,
    role,
    location: { kind: 'event', timeline: 'live', seq: index },
  })) as never
  return {
    key: 'k', kind: 'x', id: 'i',
    matches: resolved,
    start: matches.length > 0 ? resolved[0] : undefined,
    state,
    current: new Map(),
  } as unknown as ConversationNodeContext
}

describe('external message node', () => {
  it('folds a committed agent message into a chat row', () => {
    const node = externalMessageDefinition.buildViewNode!(context([
      { event: event('external/message-added', 3, { turnId: 't1', role: 'agent', text: 'hello' }), role: 'update' }]))
    expect(node).toMatchObject({
      kind: 'external-message',
      target: 'chat',
      anchorSeq: 3,
      data: { role: 'agent', text: 'hello' },
    })
  })

  it('ignores unrelated events', () => {
    expect(externalMessageDefinition.match(event('external/tool-activity', 3, {}))).toBeNull()
  })
})

describe('external tool node', () => {
  it('folds a tool activity with optional detail', () => {
    const node = externalToolDefinition.buildViewNode!(context([
      { event: event('external/tool-activity', 4, { turnId: 't1', kind: 'result', title: 'bash', detail: 'ok' }), role: 'update' }]))
    expect(node).toMatchObject({
      kind: 'external-tool',
      data: { kind: 'result', title: 'bash', detail: 'ok' },
    })
  })
})

describe('external permission node', () => {
  it('pairs an ask with its decision by askId', () => {
    const def = externalPermissionDefinition
    const asked = event('external/permission-asked', 5, { askId: 'a1', title: 'Run?', options: ['Yes', 'No'] })
    const decided = event('external/permission-decided', 6, { askId: 'a1', outcome: 'allowed' })

    const askedMatch = def.match(asked)!
    expect(def.match(decided)).toEqual({ id: 'a1', role: 'update' })

    let state = def.start(context([{ event: asked, role: 'start' }]), { event: asked, role: 'start' } as never, undefined as never)
    state = def.update(context([{ event: asked, role: 'start' }, { event: decided, role: 'update' }], state) as never, { event: decided, role: 'update' } as never)

    const node = def.buildViewNode!(context(
      [{ event: asked, role: 'start' }, { event: decided, role: 'update' }],
      state,
    ))
    expect(node).toMatchObject({
      kind: 'external-permission',
      data: { askId: 'a1', title: 'Run?', options: ['Yes', 'No'], outcome: 'allowed' },
    })
    expect(askedMatch).toEqual({ id: 'a1', role: 'start' })
  })
})

describe('external compaction and model nodes', () => {
  it('folds a compaction notice', () => {
    const node = externalCompactionDefinition.buildViewNode!(context([
      { event: event('external/compaction-noticed', 7, { notice: 'summarized' }), role: 'update' }]))
    expect(node).toMatchObject({ kind: 'external-compaction', data: { notice: 'summarized' } })
  })

  it('folds a model switch', () => {
    const node = externalModelDefinition.buildViewNode!(context([
      { event: event('external/model-switched', 8, { model: 'gpt-5' }), role: 'update' }]))
    expect(node).toMatchObject({ kind: 'external-model', data: { model: 'gpt-5' } })
  })
})

/** A context with explicit state and no start match (decided-first stream). */
function decidedContext(state: { asked: { askId: string; title: string; options: readonly string[] } }): ConversationNodeContext {
  return {
    key: 'k', kind: 'x', id: 'i',
    matches: [{ event: event('external/permission-decided', 6, { askId: 'a1', outcome: 'allowed' }), role: 'update', location: { kind: 'event', timeline: 'live', seq: 6 } }],
    start: undefined,
    state,
    current: new Map(),
  } as unknown as ConversationNodeContext
}

describe('external message node negatives', () => {
  const def = externalMessageDefinition
  it('rejects non-message events and non-objects', () => {
    expect(def.match(event('external/tool-activity', 3, {}))).toBeNull()
    expect(def.match(null)).toBeNull()
  })
  it('no-ops start and update', () => {
    const m = { event: event('external/message-added', 3, { role: 'agent', text: 'hi' }), role: 'update' } as never
    expect(def.start(context([m]) as never, m)).toEqual({})
    expect(def.update(context([m]) as never, m)).toEqual({})
  })
  it('skips empty windows and missing payloads', () => {
    expect(def.buildViewNode!(context([]))).toBeNull()
    expect(def.buildViewNode!(context([{ event: event('external/message-added', 3, { role: 'agent' }), role: 'update' }]))).toBeNull()
    expect(def.buildViewNode!(context([{ event: null, role: 'update' }]) as never)).toBeNull()
  })
})

describe('external tool node negatives', () => {
  const def = externalToolDefinition
  it('rejects non-tool events', () => {
    expect(def.match(event('external/message-added', 4, {}))).toBeNull()
    expect(def.match(undefined)).toBeNull()
  })
  it('no-ops start and update', () => {
    const m = { event: event('external/tool-activity', 4, { kind: 'call', title: 'bash' }), role: 'update' } as never
    expect(def.start(context([m]) as never, m)).toEqual({})
    expect(def.update(context([m]) as never, m)).toEqual({})
  })
  it('skips empty windows, missing titles, and renders without detail', () => {
    expect(def.buildViewNode!(context([]))).toBeNull()
    expect(def.buildViewNode!(context([{ event: event('external/tool-activity', 4, { kind: 'call' }), role: 'update' }]))).toBeNull()
    expect(def.buildViewNode!(context([{ event: event('external/tool-activity', 4, { kind: 'call', title: 'bash' }), role: 'update' }])))
      .toMatchObject({ data: { kind: 'call', title: 'bash' } })
  })
})

describe('external permission node negatives', () => {
  const def = externalPermissionDefinition
  it('rejects malformed and unrelated events', () => {
    expect(def.match(null)).toBeNull()
    expect(def.match(event('external/permission-asked', 5, { askId: 7, title: 'x' }))).toBeNull()
    expect(def.match(event('external/permission-asked', 5, { askId: '', title: 'x' }))).toBeNull()
    expect(def.match(event('external/permission-decided', 5, { askId: '' }))).toBeNull()
    expect(def.match(event('external/message-added', 5, { role: 'agent', text: 'hi' }))).toBeNull()
  })
  it('starts from a missing event with empty defaults', () => {
    const asked = def.start(context([]) as never, { event: null, role: 'start' } as never)
    expect(asked).toEqual({ asked: { askId: '', title: '', options: [] } })
  })
  it('update returns the prior state for non-decisions and missing outcomes', () => {
    const base = { asked: { askId: 'a1', title: 'Run?', options: ['Yes'] } }
    const baseCtx = context([], base) as never
    expect(def.update(baseCtx, { event: event('external/message-added', 1, {}), role: 'update' } as never)).toEqual(base)
    expect(def.update(baseCtx, { event: null, role: 'update' } as never)).toEqual(base)
  })
  it('update defaults a missing askId on the decided arm', () => {
    const base = { asked: { askId: 'a1', title: 'Run?', options: ['Yes'] } }
    const out = def.update(context([], base) as never, { event: event('external/permission-decided', 6, { outcome: 'allowed' }), role: 'update' } as never)
    expect(out).toEqual({ ...base, decided: { askId: '', outcome: 'allowed' } })
  })
  it('skips an undefined state', () => {
    expect(def.buildViewNode!(context([], undefined))).toBeNull()
  })
  it('skips a state with no first match', () => {
    expect(def.buildViewNode!(context([], { asked: { askId: 'a1', title: 'Run?', options: ['Yes'] } }))).toBeNull()
  })
  it('builds from a decided-first stream with no start', () => {
    const node = def.buildViewNode!(decidedContext({ asked: { askId: 'a1', title: 'Run?', options: ['Yes'] } }))
    expect(node).toMatchObject({ kind: 'external-permission', anchorSeq: 0, data: { askId: 'a1' } })
  })
})

describe('external compaction and model node negatives', () => {
  const compaction = externalCompactionDefinition
  const model = externalModelDefinition
  it('reject unrelated events', () => {
    expect(compaction.match(event('external/message-added', 7, {}))).toBeNull()
    expect(model.match(event('external/message-added', 7, {}))).toBeNull()
  })
  it('no-op start and update', () => {
    const cm = { event: event('external/compaction-noticed', 7, { notice: 'n' }), role: 'update' } as never
    expect(compaction.start(context([cm]) as never, cm)).toEqual({})
    expect(compaction.update(context([cm]) as never, cm)).toEqual({})
    const mm = { event: event('external/model-switched', 7, { model: 'm' }), role: 'update' } as never
    expect(model.start(context([mm]) as never, mm)).toEqual({})
    expect(model.update(context([mm]) as never, mm)).toEqual({})
  })
  it('skip empty windows and missing payloads', () => {
    expect(compaction.buildViewNode!(context([]))).toBeNull()
    expect(compaction.buildViewNode!(context([{ event: event('external/compaction-noticed', 7, {}), role: 'update' }]))).toBeNull()
    expect(model.buildViewNode!(context([]))).toBeNull()
    expect(model.buildViewNode!(context([{ event: event('external/model-switched', 7, {}), role: 'update' }]))).toBeNull()
  })
})

describe('external single-event match happy paths', () => {
  it('matches the four single-event families', () => {
    expect(externalMessageDefinition.match(event('external/message-added', 3, { role: 'agent', text: 'hi' })))
      .toEqual({ id: '3', role: 'update' })
    expect(externalToolDefinition.match(event('external/tool-activity', 4, { kind: 'call', title: 'ls' })))
      .toEqual({ id: '4', role: 'update' })
    expect(externalCompactionDefinition.match(event('external/compaction-noticed', 7, { notice: 'n' })))
      .toEqual({ id: '7', role: 'update' })
    expect(externalModelDefinition.match(event('external/model-switched', 8, { model: 'm' })))
      .toEqual({ id: '8', role: 'update' })
  })
  it('defaults the tool kind when absent', () => {
    const node = externalToolDefinition.buildViewNode!(context([
      { event: event('external/tool-activity', 4, { title: 'ls' }), role: 'update' }]))
    expect(node).toMatchObject({ data: { kind: 'call', title: 'ls' } })
  })
})
