/**
 * Transient external-agent transcript accumulation. The host sends text
 * fragments separately from durable session events; this accumulator keeps
 * the current turn's arrival order and retires a turn once its committed
 * message reaches the client.
 */

/** One rendered external-agent partial message. */
export interface ExternalLiveMessage {
  /** Provider-owned turn identity. */
  readonly turnId: string
  /** Text accumulated from ordered delta frames. */
  readonly text: string
}

/** Compatibility name for callers that describe the value as a partial. */
export type ExternalLivePartial = ExternalLiveMessage

/**
 * Accumulates transient external deltas without making them durable.
 * Instances belong to one client Session. A terminal session event closes the
 * current generation; connection and subscription resets open a new one.
 */
export class ExternalLiveAccumulator {
  private readonly turns = new Map<string, string>()
  private readonly retired = new Set<string>()
  private activeTurnId: string | undefined
  private closed = false

  /**
   * Append one ordered delta.
   * @param turnId - provider-owned turn identity.
   * @param delta - incremental text.
   * @returns whether the visible partial changed.
   */
  push(turnId: string, delta: string): boolean {
    if (this.closed || this.retired.has(turnId) || delta.length === 0) return false
    this.turns.set(turnId, (this.turns.get(turnId) ?? '') + delta)
    this.activeTurnId = turnId
    return true
  }

  /**
   * Retire one turn after its durable external message arrives.
   * @param turnId - the committed provider turn.
   * @returns whether a partial was removed or the turn was newly retired.
   */
  commit(turnId: string): boolean {
    const hadPartial = this.turns.delete(turnId)
    const wasRetired = this.retired.has(turnId)
    this.retired.add(turnId)
    if (this.activeTurnId === turnId) {
      this.activeTurnId = [...this.turns.keys()].at(-1)
    }
    return hadPartial || !wasRetired
  }

  /**
   * Clear one turn, or the entire live generation when no id is supplied.
   * @param turnId - optional turn identity to clear.
   * @returns whether visible state changed.
   */
  clear(turnId?: string): boolean {
    if (turnId === undefined) {
      const changed = this.turns.size > 0 || this.activeTurnId !== undefined || this.retired.size > 0
      this.reset()
      return changed
    }
    const changed = this.turns.delete(turnId) || this.activeTurnId === turnId
    if (this.activeTurnId === turnId) this.activeTurnId = [...this.turns.keys()].at(-1)
    return changed
  }

  /**
   * Close the current session generation and reject late stream deltas.
   * @returns whether the accumulator changed.
   */
  close(): boolean {
    const changed = !this.closed
      || this.turns.size > 0
      || this.activeTurnId !== undefined
      || this.retired.size > 0
    this.reset()
    this.closed = true
    return changed
  }

  /** Reset all partials and retired-turn guards for a new connection generation. */
  reset(): void {
    this.turns.clear()
    this.retired.clear()
    this.activeTurnId = undefined
    this.closed = false
  }

  /**
   * Read the current live seat.
   * @returns the latest active partial, or null when no partial is visible.
   */
  snapshot(): ExternalLiveMessage | null {
    if (this.activeTurnId === undefined) return null
    const text = this.turns.get(this.activeTurnId)
    return text === undefined || text.length === 0 ? null : { turnId: this.activeTurnId, text }
  }
}
