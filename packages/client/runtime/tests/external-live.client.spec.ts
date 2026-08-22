import { describe, expect, it } from 'vitest'
import { ExternalLiveAccumulator } from '../src/client/sessions/external-live.ts'

describe('ExternalLiveAccumulator', () => {
  it('accumulates ordered deltas for one turn and retires the turn on commit', () => {
    const live = new ExternalLiveAccumulator()

    expect(live.push('turn-1', 'first')).toBe(true)
    expect(live.push('turn-1', ' second')).toBe(true)
    expect(live.snapshot()).toEqual({ turnId: 'turn-1', text: 'first second' })

    expect(live.commit('turn-1')).toBe(true)
    expect(live.snapshot()).toBeNull()
    expect(live.push('turn-1', 'late')).toBe(false)
    expect(live.snapshot()).toBeNull()
  })

  it('clears all turns on a connection-generation reset', () => {
    const live = new ExternalLiveAccumulator()
    live.push('turn-1', 'one')
    live.push('turn-2', 'two')
    live.reset()

    expect(live.snapshot()).toBeNull()
    expect(live.push('turn-1', 'after reset')).toBe(true)
  })
})
