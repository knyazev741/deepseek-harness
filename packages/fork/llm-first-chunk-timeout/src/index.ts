/**
 * Bounds the wait for the first result from an LLM stream while preserving
 * provider cancellation and every later iterator result. When that first-read
 * deadline wins, the stream ends with a `FIRST_CHUNK_TIMEOUT` failure and the
 * companion `agent/request-error` recovery forces one context compaction
 * before queuing a `continue` follow-up from the replacement surface.
 *
 * @module @knyazevai/dsh-fork-llm-first-chunk-timeout
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, type GenerateOptions, type StreamChunk } from '@knyazevai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@knyazevai/dsh-timeout'
import { createRecovery, FIRST_CHUNK_TIMEOUT_CODE } from './recovery.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fork-llm-first-chunk-timeout'

/** The LLM service whose stream waterfall this plugin wraps. */
export const inject = ['llm']

/** Configuration for the first result deadline and its compaction recovery. */
export interface Config {
  /** Maximum idle time before the first iterator result, defaulting to 120000ms. */
  readonly firstChunkIdleTimeoutMs?: number
  /** Maximum consecutive first-chunk compaction follow-ups before idle (default 100). */
  readonly maxFirstChunkCompactionRetries?: number
}

/** The default agent-facing first-result deadline. */
const DEFAULT_FIRST_CHUNK_IDLE_TIMEOUT_MS = 120_000

/** The default ceiling on consecutive first-chunk compaction follow-ups. */
const DEFAULT_MAX_FIRST_CHUNK_COMPACTION_RETRIES = 100

/** Loader schema for {@link Config}. */
export const Config: z<Config> = z.object({
  firstChunkIdleTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_FIRST_CHUNK_IDLE_TIMEOUT_MS),
  maxFirstChunkCompactionRetries: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_FIRST_CHUNK_COMPACTION_RETRIES),
})

type StreamIterator = AsyncIterator<StreamChunk>
type StreamResult = IteratorResult<StreamChunk>
type TimerHandle = ReturnType<typeof setTimeout>

interface PendingRead {
  readonly resolve: (result: StreamResult) => void
  readonly reject: (error: unknown) => void
}

/** A custom iterator is required so consumer control is not queued behind a provider read. */
class FirstChunkStream implements AsyncIterable<StreamChunk>, AsyncIterator<StreamChunk> {
  private readonly waiters: PendingRead[] = []
  private iterator: StreamIterator | undefined
  private currentRead: PendingRead | undefined
  private currentReadId = 0
  private readGeneration = 0
  private timer: TimerHandle | undefined
  private abortListener: (() => void) | undefined
  private phase: 'first' | 'open' | 'closed' = 'first'
  private readInFlight = false

  constructor(
    private readonly source: AsyncIterable<StreamChunk>,
    private readonly signal: AbortSignal | undefined,
    private readonly timeoutMs: number,
    private readonly onTerminal: () => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    return this
  }

  next(): Promise<StreamResult> {
    if (this.phase === 'closed') return Promise.resolve(doneResult())
    const promise = new Promise<StreamResult>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
    this.pump()
    return promise
  }

  return(value?: unknown): Promise<StreamResult> {
    this.closeForConsumer()
    return Promise.resolve({ done: true, value } as StreamResult)
  }

  throw(error?: unknown): Promise<StreamResult> {
    if (this.phase === 'closed') return rejected(error)
    this.clearDeadline()
    this.phase = 'closed'
    this.readInFlight = false
    this.invalidateRead()
    this.resolvePendingReads()

    let iterator: StreamIterator
    try {
      iterator = this.createIterator()
    } catch (throwFailure) {
      this.notifyTerminal()
      return rejected(throwFailure)
    }
    if (iterator.throw === undefined) {
      this.closeDownstream()
      this.notifyTerminal()
      return rejected(error)
    }

    let result: Promise<StreamResult>
    try {
      result = Promise.resolve(iterator.throw.call(iterator, error))
    } catch (throwFailure) {
      this.notifyTerminal()
      return rejected(throwFailure)
    }
    return result.then(
      (value) => {
        if (value.done) {
          this.notifyTerminal()
        } else {
          this.phase = 'open'
        }
        return value
      },
      (throwFailure: unknown) => {
        this.notifyTerminal()
        return rejected(throwFailure)
      },
    )
  }

  /** Dispose plugin-owned state and settle wrapper reads without waiting for the provider. */
  dispose(): void {
    if (this.phase === 'closed') return
    this.closeForConsumer()
  }

  private pump(): void {
    if (this.readInFlight) return
    const pending = this.waiters.shift()
    if (pending === undefined) return
    const iterator = this.getIterator(pending)
    if (iterator === undefined) return

    this.currentRead = pending
    const readId = ++this.readGeneration
    this.currentReadId = readId
    this.readInFlight = true
    const first = this.phase === 'first'
    if (first) this.armDeadline()

    let operation: Promise<StreamResult>
    try {
      operation = Promise.resolve(iterator.next())
    } catch (error) {
      operation = rejected(error)
    }
    operation.then(
      (result) => { this.resolveRead(result, first, readId) },
      (error: unknown) => { this.rejectRead(error, readId) },
    )
  }

  private getIterator(pending: PendingRead): StreamIterator | undefined {
    try {
      return this.createIterator()
    } catch (error) {
      this.phase = 'closed'
      this.readInFlight = false
      pending.reject(error)
      this.resolvePendingReads()
      this.notifyTerminal()
      return undefined
    }
  }

  private createIterator(): StreamIterator {
    if (this.iterator !== undefined) return this.iterator
    this.iterator = this.source[Symbol.asyncIterator]()
    return this.iterator
  }

  private resolveRead(result: StreamResult, first: boolean, readId: number): void {
    if (readId !== this.currentReadId) return
    this.readInFlight = false
    this.currentReadId = 0
    const pending = this.currentRead as PendingRead
    this.currentRead = undefined
    if (first) this.clearDeadline()
    if (result.done) {
      this.phase = 'closed'
      pending.resolve(result)
      this.resolvePendingReads()
      this.notifyTerminal()
      return
    }
    this.phase = 'open'
    pending.resolve(result)
    this.pump()
  }

  private rejectRead(error: unknown, readId: number): void {
    if (readId !== this.currentReadId) return
    this.readInFlight = false
    this.currentReadId = 0
    const pending = this.currentRead as PendingRead
    this.currentRead = undefined
    this.clearDeadline()
    this.phase = 'closed'
    pending.reject(error)
    this.resolvePendingReads()
    this.closeDownstream()
    this.notifyTerminal()
  }

  private armDeadline(): void {
    if (this.signal?.aborted) return
    this.abortListener = () => { this.clearDeadline() }
    this.signal?.addEventListener('abort', this.abortListener, { once: true })
    this.timer = setTimeout(() => { this.expireDeadline() }, this.timeoutMs)
  }

  private expireDeadline(): void {
    if (this.phase !== 'first' || !this.readInFlight) return
    const pending = this.currentRead
    this.phase = 'closed'
    this.readInFlight = false
    this.invalidateRead()
    this.clearDeadline()
    this.closeDownstream()
    const pendingRead = pending as PendingRead
    pendingRead.resolve({ done: false, value: timeoutChunk(this.timeoutMs) })
    this.currentRead = undefined
    this.resolvePendingReads()
    this.notifyTerminal()
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

  private closeForConsumer(): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.readInFlight = false
    this.invalidateRead()
    this.clearDeadline()
    this.resolvePendingReads()
    this.closeDownstream()
    this.notifyTerminal()
  }

  private resolvePendingReads(): void {
    const done = doneResult()
    const pending = this.currentRead
    this.currentRead = undefined
    if (pending !== undefined) pending.resolve(done)
    while (this.waiters.length > 0) this.waiters.shift()?.resolve(done)
  }

  private invalidateRead(): void {
    this.readGeneration += 1
    this.currentReadId = 0
  }

  private closeDownstream(): void {
    const iterator = this.iterator
    if (iterator === undefined || iterator.return === undefined) return
    try {
      void Promise.resolve(iterator.return.call(iterator)).catch((error: unknown) => {
        void error
      })
    } catch (error) {
      void error
    }
  }

  private notifyTerminal(): void {
    this.onTerminal()
  }
}

function rejected<T>(error: unknown): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const rejectValue: (reason: unknown) => void = reject
    rejectValue(error)
  })
}

function doneResult(): StreamResult {
  return { done: true, value: undefined }
}

/** Build the terminal chunk emitted when this plugin's first-read timer wins. */
function timeoutChunk(timeoutMs: number): StreamChunk {
  const failure = new LlmError(`first LLM chunk idle timeout after ${timeoutMs}ms`, FIRST_CHUNK_TIMEOUT_CODE).failure
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/** Validate the resolved timeout independently of loader schema normalization. */
function resolveConfig(config: Config | undefined): { timeoutMs: number; maxCompactionRetries: number } {
  const timeoutMs = config?.firstChunkIdleTimeoutMs ?? DEFAULT_FIRST_CHUNK_IDLE_TIMEOUT_MS
  const maxCompactionRetries = config?.maxFirstChunkCompactionRetries ?? DEFAULT_MAX_FIRST_CHUNK_COMPACTION_RETRIES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `fork-llm-first-chunk-timeout: firstChunkIdleTimeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (!Number.isSafeInteger(maxCompactionRetries) || maxCompactionRetries <= 0) {
    throw new Error('fork-llm-first-chunk-timeout: maxFirstChunkCompactionRetries must be a positive safe integer')
  }
  return { timeoutMs, maxCompactionRetries }
}

/** Wrap one downstream stream until its first iterator result. */
function wrapStream(
  source: AsyncIterable<StreamChunk>,
  options: GenerateOptions,
  timeoutMs: number,
  active: Set<FirstChunkStream>,
): AsyncIterable<StreamChunk> {
  const stream = new FirstChunkStream(source, options.signal, timeoutMs, () => active.delete(stream))
  active.add(stream)
  return stream
}

/** Register the first-result deadline around the `llm/stream` waterfall. */
export function apply(ctx: Context, config?: Config): void {
  const { timeoutMs, maxCompactionRetries } = resolveConfig(config)
  const active = new Set<FirstChunkStream>()
  const disposeListener = ctx.on('llm/stream', (options, next) => {
    const source = next()
    return wrapStream(source, options, timeoutMs, active)
  })
  // The recovery listener is prepended so it claims the first-chunk timeout
  // before `dsh-llm-retry`'s fast backoff, which cannot fix a stalled first
  // chunk: compact the context, then queue a new `continue` turn.
  const recovery = createRecovery(ctx, maxCompactionRetries)
  const disposeRecovery = ctx.on('agent/request-error', recovery.listener, { prepend: true })

  ctx.effect(() => () => {
    for (const stream of active) stream.dispose()
    active.clear()
    disposeRecovery()
    recovery.dispose()
    disposeListener()
  }, 'fork-llm-first-chunk-timeout: clear active deadlines')
}
