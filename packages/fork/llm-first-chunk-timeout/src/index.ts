/**
 * Bounds the wait for the first result from an LLM stream while preserving
 * provider cancellation and every later iterator result.
 *
 * @module @deepseek-ai/dsh-fork-llm-first-chunk-timeout
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fork-llm-first-chunk-timeout'

/** The LLM service whose stream waterfall this plugin wraps. */
export const inject = ['llm']

/** Configuration for the first result deadline. */
export interface Config {
  /** Maximum idle time before the first iterator result, defaulting to 120000ms. */
  readonly firstChunkIdleTimeoutMs?: number
}

/** The default agent-facing first-result deadline. */
const DEFAULT_FIRST_CHUNK_IDLE_TIMEOUT_MS = 120_000

/** Loader schema for {@link Config}. */
export const Config: z<Config> = z.object({
  firstChunkIdleTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_FIRST_CHUNK_IDLE_TIMEOUT_MS),
})

type StreamIterator = AsyncIterator<StreamChunk>
type TimerHandle = ReturnType<typeof setTimeout>

type FirstResult =
  | { readonly timedOut: true }
  | { readonly timedOut: false; readonly result: IteratorResult<StreamChunk> }

/** Owns one stream's timer, caller-abort listener, and best-effort downstream close. */
class StreamState {
  private timer: TimerHandle | undefined
  private abortListener: (() => void) | undefined
  private firstSettled = false
  private closed = false
  private naturallyDone = false
  private disposed = false

  constructor(
    private readonly iterator: StreamIterator,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /** Arm the first-result timer and resolve once the first read settles or expires. */
  waitForFirst(timeoutMs: number): Promise<FirstResult> {
    return new Promise<FirstResult>((resolve, reject) => {
      const settle = (result: FirstResult): void => {
        if (this.firstSettled) return
        this.firstSettled = true
        this.clearDeadline()
        resolve(result)
      }
      const fail = (error: unknown): void => {
        this.firstSettled = true
        this.clearDeadline()
        reject(error)
      }

      if (!this.signal?.aborted) {
        this.timer = setTimeout(() => {
          if (this.firstSettled || this.disposed) return
          this.firstSettled = true
          this.clearDeadline()
          this.closeDownstream()
          settleTimeout(resolve)
        }, timeoutMs)
        this.abortListener = () => {
          // The provider's cancellation result remains authoritative after a
          // caller abort; this listener only removes our competing deadline.
          this.clearDeadline()
        }
        this.signal?.addEventListener('abort', this.abortListener, { once: true })
      }

      let pending: Promise<IteratorResult<StreamChunk>>
      try {
        pending = Promise.resolve(this.iterator.next())
      } catch (error) {
        fail(error)
        return
      }

      // The rejection handler deliberately consumes a read that settles after
      // our timer won, because no consumer remains to observe that provider
      // failure once the timeout chunk has been emitted.
      pending.then(
        result => settle({ timedOut: false, result }),
        (error) => {
          if (!this.firstSettled) fail(error)
        },
      )
    })
  }

  /** Record natural EOF so finalization does not call `return()` again. */
  markDone(): void {
    this.naturallyDone = true
  }

  /** Stop plugin-owned state and close the provider without awaiting it. */
  dispose(): void {
    this.disposed = true
    this.clearDeadline()
    this.closeDownstream()
  }

  /** Close this wrapper after consumer return, an error, or natural completion. */
  finish(): void {
    this.clearDeadline()
    if (!this.naturallyDone) this.closeDownstream()
  }

  private clearDeadline(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.abortListener !== undefined) {
      this.signal?.removeEventListener('abort', this.abortListener)
      this.abortListener = undefined
    }
  }

  private closeDownstream(): void {
    if (this.closed || this.naturallyDone) return
    this.closed = true
    try {
      const close = this.iterator.return
      if (close === undefined) return
      // Do not await this operation: async iterator return can be queued
      // behind the still-pending provider read that caused the timeout.
      void Promise.resolve(close.call(this.iterator)).catch((error: unknown) => {
        // Closing is best-effort after timeout or consumer disposal; the
        // already-selected stream outcome remains authoritative.
        void error
      })
    } catch (error) {
      // A synchronous close failure cannot replace the timeout or consumer
      // result, so contain it for the same best-effort lifecycle reason.
      void error
    }
  }
}

/** Build the terminal chunk emitted when this plugin's first-read timer wins. */
function timeoutChunk(timeoutMs: number): StreamChunk {
  const failure = new LlmError(`first LLM chunk idle timeout after ${timeoutMs}ms`, 'TIMEOUT').failure
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/** Resolve the timer winner without letting a late read race produce another value. */
function settleTimeout(resolve: (result: FirstResult) => void): void {
  resolve({ timedOut: true })
}

/** Validate the resolved timeout independently of loader schema normalization. */
function resolveTimeout(config: Config | undefined): number {
  const timeoutMs = config?.firstChunkIdleTimeoutMs ?? DEFAULT_FIRST_CHUNK_IDLE_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `fork-llm-first-chunk-timeout: firstChunkIdleTimeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return timeoutMs
}

/** Wrap one downstream stream until its first iterator result. */
async function* wrapStream(
  source: AsyncIterable<StreamChunk>,
  options: GenerateOptions,
  timeoutMs: number,
  active: Set<StreamState>,
): AsyncIterable<StreamChunk> {
  const iterator = source[Symbol.asyncIterator]()
  const state = new StreamState(iterator, options.signal)
  active.add(state)
  try {
    const first = await state.waitForFirst(timeoutMs)
    if (first.timedOut) {
      yield timeoutChunk(timeoutMs)
      return
    }
    const result = first.result
    if (result.done) {
      state.markDone()
      return
    }
    yield result.value
    for (;;) {
      const next = await iterator.next()
      if (next.done) {
        state.markDone()
        return
      }
      yield next.value
    }
  } finally {
    state.finish()
    active.delete(state)
  }
}

/** Register the first-result deadline around the `llm/stream` waterfall. */
export function apply(ctx: Context, config?: Config): void {
  const timeoutMs = resolveTimeout(config)
  const active = new Set<StreamState>()
  const disposeListener = ctx.on('llm/stream', (options, next) => {
    const source = next()
    return wrapStream(source, options, timeoutMs, active)
  })

  ctx.effect(() => () => {
    for (const state of active) state.dispose()
    active.clear()
    disposeListener()
  }, 'fork-llm-first-chunk-timeout: clear active deadlines')
}
