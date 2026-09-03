import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { createUserMessage, LlmAdapter, resolveRetryPolicy, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as FirstChunkTimeout from '../src/index.ts'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'


interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function options(signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'test-provider',
    model: 'test-model',
    messages: [],
    ...(signal === undefined ? {} : { signal }),
  }
}

const FIRST: StreamChunk = { type: 'text-delta', index: 0, text: 'first' }
const SECOND: StreamChunk = { type: 'text-delta', index: 0, text: 'second' }
const ABORTED: StreamChunk = {
  type: 'finish',
  reason: { kind: 'aborted', failure: { message: 'provider aborted', code: 'ABORTED' } },
}

interface ScriptedStream extends AsyncIterable<StreamChunk> {
  readonly returnCalls: number
  readonly nextCalls: number
}

function scriptedStream(steps: Array<
  | { readonly result: IteratorResult<StreamChunk> }
  | { readonly promise: Promise<IteratorResult<StreamChunk>> }
  | { readonly error: Error }
>): ScriptedStream {
  let position = 0
  let returnCalls = 0
  let nextCalls = 0
  const iterator: AsyncIterator<StreamChunk> & AsyncIterable<StreamChunk> = {
    async next() {
      nextCalls += 1
      const step = steps[position++]
      if (step === undefined) return { done: true, value: undefined }
      if ('error' in step) throw step.error
      if ('promise' in step) return step.promise
      return step.result
    },
    async return() {
      returnCalls += 1
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  return {
    [Symbol.asyncIterator]() {
      return iterator
    },
    get returnCalls() {
      return returnCalls
    },
    get nextCalls() {
      return nextCalls
    },
  }
}

const contexts: Context[] = []
const loaderRoots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(loaderRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(timeoutMs = 10): Promise<{ readonly ctx: Context; readonly fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const fiber = await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: timeoutMs })
  return { ctx, fiber }
}

function waterfall(ctx: Context, source: AsyncIterable<StreamChunk>, signal?: AbortSignal): AsyncIterable<StreamChunk> {
  return ctx.waterfall(ctx as never, 'llm/stream', options(signal), () => source)
}

async function firstResult(stream: AsyncIterable<StreamChunk>): Promise<IteratorResult<StreamChunk>> {
  return stream[Symbol.asyncIterator]().next()
}

/** Emit one agent-status notification for the partial test agent without building a full Agent instance. */
function emitAgentStatus(ctx: Context, agent: object, status: 'idle' | 'running'): void {
  ctx.emit('agent/status', { agent, status } as never)
}

describe('first-chunk idle timeout waterfall', () => {
  it('leaves the upstream waterfall unchanged when the plugin is absent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const source = scriptedStream([{ result: { done: false, value: FIRST } }])
    const stream = waterfall(ctx, source)

    expect(stream).toBe(source)
    await expect(firstResult(stream)).resolves.toEqual({ done: false, value: FIRST })
  })

  it('forwards the identical first chunk and later chunks despite a long gap', async () => {
    vi.useFakeTimers()
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const later = deferred<IteratorResult<StreamChunk>>()
    const source = scriptedStream([
      { result: { done: false, value: FIRST } },
      { promise: later.promise },
      { result: { done: true, value: undefined } },
    ])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first).toEqual({ done: false, value: FIRST })
    expect(first.value).toBe(FIRST)
    const capturedTimer = timerSpy.mock.calls.at(-1)?.[0]
    if (capturedTimer === undefined) throw new Error('first-result timer was not armed')
    capturedTimer()
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.getTimerCount()).toBe(0)

    later.resolve({ done: false, value: SECOND })
    const second = await iterator.next()
    expect(second).toEqual({ done: false, value: SECOND })
    expect(second.value).toBe(SECOND)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(source.nextCalls).toBe(3)
  })

  it('calls the zero-argument continuation once without rewriting the frozen request', async () => {
    const source = scriptedStream([{ result: { done: false, value: FIRST } }])
    const { ctx } = await setup(10)
    let continuationCalls = 0
    const request = options()
    const stream = ctx.waterfall(ctx as never, 'llm/stream', request, () => {
      continuationCalls += 1
      return source
    })

    await expect(firstResult(stream)).resolves.toEqual({ done: false, value: FIRST })
    expect(continuationCalls).toBe(1)
    expect(request).toEqual(options())
  })

  it('yields one retryable FIRST_CHUNK_TIMEOUT terminal chunk and initiates downstream close', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    const source = scriptedStream([{ promise: pending.promise }])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    const read = iterator.next()
    await vi.advanceTimersByTimeAsync(10)
    await expect(read).resolves.toEqual({
      done: false,
      value: {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'first LLM chunk idle timeout after 10ms',
            code: 'FIRST_CHUNK_TIMEOUT',
          },
        },
      },
    })
    // The code is retryable only when the deployment's retry policy lists it,
    // as the fork provider configuration does.
    const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0, retryableCodes: ['FIRST_CHUNK_TIMEOUT'] }, 'test')
    if (policy.mode !== 'normal') throw new Error('explicit retry policy must be bounded')
    expect(policy.retryableCodes).toContain('FIRST_CHUNK_TIMEOUT')
    expect(source.returnCalls).toBe(1)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })

    pending.reject(new Error('late provider rejection'))
    await Promise.resolve()
  })

  it('completes normally when downstream ends before the deadline', async () => {
    vi.useFakeTimers()
    const source = scriptedStream([{ result: { done: true, value: undefined } }])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
    expect(source.returnCalls).toBe(0)
  })

  it('propagates an ordinary downstream rejection unchanged', async () => {
    vi.useFakeTimers()
    const failure = new Error('provider failed')
    const source = scriptedStream([{ error: failure }])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toBe(failure)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a synchronous downstream iterator failure unchanged', async () => {
    vi.useFakeTimers()
    const failure = new Error('synchronous provider failure')
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return { next: () => { throw failure } }
      },
    }
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toBe(failure)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a synchronous downstream iterator-construction failure unchanged', async () => {
    const failure = new Error('synchronous provider construction failure')
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        throw failure
      },
    }
    const { ctx } = await setup(10)

    await expect(firstResult(waterfall(ctx, source))).rejects.toBe(failure)
  })

  it('lets caller cancellation win without emitting TIMEOUT', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = deferred<IteratorResult<StreamChunk>>()
    controller.signal.addEventListener('abort', () => { pending.resolve({ done: false, value: ABORTED }) }, { once: true })
    const source = scriptedStream([{ promise: pending.promise }])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source, controller.signal)[Symbol.asyncIterator]()
    const read = iterator.next()

    controller.abort()
    await vi.advanceTimersByTimeAsync(100)
    await expect(read).resolves.toEqual({ done: false, value: ABORTED })
    expect(vi.getTimerCount()).toBe(0)
    expect(source.returnCalls).toBe(0)
  })

  it('does not arm a plugin timer for an already-aborted caller', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    const source = scriptedStream([{ result: { done: false, value: ABORTED } }])
    const { ctx } = await setup(10)

    await expect(firstResult(waterfall(ctx, source, controller.signal))).resolves.toEqual({ done: false, value: ABORTED })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps concurrent streams independent', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    const slow = scriptedStream([{ promise: pending.promise }])
    const fast = scriptedStream([
      { result: { done: false, value: FIRST } },
      { result: { done: true, value: undefined } },
    ])
    const { ctx } = await setup(10)
    const slowIterator = waterfall(ctx, slow)[Symbol.asyncIterator]()
    const fastIterator = waterfall(ctx, fast)[Symbol.asyncIterator]()
    const slowRead = slowIterator.next()

    await expect(fastIterator.next()).resolves.toEqual({ done: false, value: FIRST })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    await expect(slowRead).resolves.toMatchObject({ value: { reason: { kind: 'error', failure: { code: 'FIRST_CHUNK_TIMEOUT' } } } })
    expect(slow.returnCalls).toBe(1)
    pending.resolve({ done: true, value: undefined })
  })

  it('closes downstream on early consumer return and clears its timer', async () => {
    vi.useFakeTimers()
    const later = deferred<IteratorResult<StreamChunk>>()
    const source = scriptedStream([
      { result: { done: false, value: FIRST } },
      { promise: later.promise },
    ])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: FIRST })
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    expect(source.returnCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    later.resolve({ done: true, value: undefined })
    await Promise.resolve()
  })

  it('returns immediately while the first downstream read is pending', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    const source = scriptedStream([{ promise: pending.promise }])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()
    const read = iterator.next()

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    expect(source.returnCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await expect(read).resolves.toEqual({ done: true, value: undefined })

    pending.resolve({ done: false, value: FIRST })
    await Promise.resolve()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('rejects a consumer throw after the wrapper has closed', async () => {
    const thrown = new Error('consumer failed')
    const source = scriptedStream([{ result: { done: true, value: undefined } }])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(iterator.throw?.(thrown)).rejects.toBe(thrown)
  })

  it('delegates consumer throw before the first read', async () => {
    const thrown = new Error('consumer stopped')
    const throwResult: IteratorResult<StreamChunk> = { done: true, value: undefined }
    let received: unknown
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: true, value: undefined }),
          throw: (error: unknown) => {
            received = error
            return Promise.resolve(throwResult)
          },
        }
      },
    }
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.throw?.(thrown)).resolves.toBe(throwResult)
    expect(received).toBe(thrown)
  })

  it('propagates iterator construction failure from consumer throw', async () => {
    const failure = new Error('throw construction failure')
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        throw failure
      },
    }
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.throw?.(new Error('consumer failed'))).rejects.toBe(failure)
  })

  it('settles a concurrently queued next without starting another downstream read', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    const source = scriptedStream([{ promise: pending.promise }])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()
    const firstRead = iterator.next()
    const queuedRead = iterator.next()

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    await expect(firstRead).resolves.toEqual({ done: true, value: undefined })
    await expect(queuedRead).resolves.toEqual({ done: true, value: undefined })
    expect(source.nextCalls).toBe(1)
    pending.resolve({ done: false, value: FIRST })
    await Promise.resolve()
  })

  it('returns immediately while a later downstream read is pending', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    const source = scriptedStream([
      { result: { done: false, value: FIRST } },
      { promise: pending.promise },
    ])
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: FIRST })
    const read = iterator.next()
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    expect(source.returnCalls).toBe(1)
    await expect(read).resolves.toEqual({ done: true, value: undefined })

    pending.resolve({ done: false, value: SECOND })
    await Promise.resolve()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('delegates consumer throw and preserves its result after the first chunk', async () => {
    const thrown = new Error('consumer stopped')
    const throwResult: IteratorResult<StreamChunk> = { done: true, value: undefined }
    let received: unknown
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: vi.fn()
            .mockResolvedValueOnce({ done: false, value: FIRST })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          throw(error: unknown) {
            received = error
            return Promise.resolve(throwResult)
          },
          return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
        }
      },
    }
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: FIRST })
    await expect(iterator.throw?.(thrown)).resolves.toBe(throwResult)
    expect(received).toBe(thrown)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('keeps a downstream throw value transparent and ignores the interrupted read', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    let nextCalls = 0
    const throwResult: IteratorResult<StreamChunk> = { done: false, value: SECOND }
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            nextCalls += 1
            return nextCalls === 1
              ? pending.promise
              : Promise.resolve({ done: true, value: undefined })
          },
          throw: () => Promise.resolve(throwResult),
        }
      },
    }
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()
    const read = iterator.next()

    await expect(iterator.throw?.(new Error('recover'))).resolves.toBe(throwResult)
    await expect(read).resolves.toEqual({ done: true, value: undefined })
    pending.resolve({ done: false, value: FIRST })
    await Promise.resolve()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('preserves a downstream throw rejection', async () => {
    const thrown = new Error('consumer failed')
    const downstreamFailure = new Error('downstream throw failed')
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: FIRST }),
          throw: () => Promise.reject(downstreamFailure),
        }
      },
    }
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: FIRST })
    await expect(iterator.throw?.(thrown)).rejects.toBe(downstreamFailure)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('preserves a synchronous downstream throw failure', async () => {
    const thrown = new Error('consumer failed')
    const downstreamFailure = new Error('synchronous downstream throw failed')
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: FIRST }),
          throw: () => { throw downstreamFailure },
        }
      },
    }
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: FIRST })
    await expect(iterator.throw?.(thrown)).rejects.toBe(downstreamFailure)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('rejects consumer throw with the caller error when downstream has no throw', async () => {
    const thrown = new Error('consumer failed')
    let returnCalls = 0
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: FIRST }),
          return: () => {
            returnCalls += 1
            return Promise.resolve({ done: true, value: undefined })
          },
        }
      },
    }
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: FIRST })
    await expect(iterator.throw?.(thrown)).rejects.toBe(thrown)
    expect(returnCalls).toBe(1)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('clears the first-result timer and delegates consumer throw while a read is pending', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    const thrown = new Error('consumer failed')
    let throwCalls = 0
    const throwResult: IteratorResult<StreamChunk> = { done: true, value: undefined }
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => pending.promise,
          throw: (error: unknown) => {
            expect(error).toBe(thrown)
            throwCalls += 1
            return Promise.resolve(throwResult)
          },
        }
      },
    }
    const { ctx } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()
    const read = iterator.next()

    await expect(iterator.throw?.(thrown)).resolves.toBe(throwResult)
    expect(throwCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await expect(read).resolves.toEqual({ done: true, value: undefined })

    pending.resolve({ done: false, value: FIRST })
    await vi.advanceTimersByTimeAsync(100)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('removes its waterfall listener and clears active timers at disposal without waiting for provider reads', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    const returnPending = deferred<IteratorResult<StreamChunk>>()
    let returnCalls = 0
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => pending.promise,
          return: () => {
            returnCalls += 1
            return returnPending.promise
          },
        }
      },
    }
    const { ctx, fiber } = await setup(10)
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()
    const read = iterator.next()
    expect(vi.getTimerCount()).toBe(1)

    await fiber.dispose()
    const capturedTimer = timerSpy.mock.calls.at(-1)?.[0]
    if (capturedTimer !== undefined) capturedTimer()
    expect(returnCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    pending.resolve({ done: false, value: FIRST })
    await expect(read).resolves.toEqual({ done: true, value: undefined })
    returnPending.resolve({ done: true, value: undefined })
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })

    const passthrough = scriptedStream([{ result: { done: false, value: SECOND } }])
    const stream = waterfall(ctx, passthrough)
    expect(stream).toBe(passthrough)
    await expect(firstResult(stream)).resolves.toEqual({ done: false, value: SECOND })
  })

  it('does not re-enter a wrapper already waiting for downstream throw during disposal', async () => {
    const throwPending = deferred<IteratorResult<StreamChunk>>()
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: FIRST }),
          throw: () => throwPending.promise,
        }
      },
    }
    const { ctx, fiber } = await setup(10)
    const iterator = waterfall(ctx, source)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: FIRST })
    const control = iterator.throw?.(new Error('consumer failed'))

    await fiber.dispose()
    throwPending.resolve({ done: true, value: undefined })
    await expect(control).resolves.toEqual({ done: true, value: undefined })
  })

  it('contains synchronous and asynchronous downstream close failures', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    const asyncCloseSource: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => pending.promise,
          return: () => Promise.reject(new Error('async close failed')),
        }
      },
    }
    const { ctx } = await setup(10)
    const asyncRead = waterfall(ctx, asyncCloseSource)[Symbol.asyncIterator]().next()
    await vi.advanceTimersByTimeAsync(10)
    await expect(asyncRead).resolves.toMatchObject({ value: { reason: { kind: 'error', failure: { code: 'FIRST_CHUNK_TIMEOUT' } } } })
    pending.resolve({ done: true, value: undefined })
    await Promise.resolve()

    const syncClosePending = deferred<IteratorResult<StreamChunk>>()
    const syncCloseSource: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => syncClosePending.promise,
          return: () => { throw new Error('sync close failed') },
        }
      },
    }
    const syncRead = waterfall(ctx, syncCloseSource)[Symbol.asyncIterator]().next()
    await vi.advanceTimersByTimeAsync(10)
    await expect(syncRead).resolves.toMatchObject({ value: { reason: { kind: 'error', failure: { code: 'FIRST_CHUNK_TIMEOUT' } } } })
    syncClosePending.resolve({ done: true, value: undefined })
    await Promise.resolve()
  })

  it('handles a downstream iterator without return()', async () => {
    vi.useFakeTimers()
    const pending = deferred<IteratorResult<StreamChunk>>()
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return { next: () => pending.promise }
      },
    }
    const { ctx } = await setup(10)
    const read = waterfall(ctx, source)[Symbol.asyncIterator]().next()

    await vi.advanceTimersByTimeAsync(10)
    await expect(read).resolves.toMatchObject({ value: { reason: { kind: 'error', failure: { code: 'FIRST_CHUNK_TIMEOUT' } } } })
    pending.resolve({ done: true, value: undefined })
    await Promise.resolve()
  })
})

describe('first-chunk idle timeout configuration', () => {
  it('defaults to 120000ms and 100 compaction follow-ups', () => {
    expect(FirstChunkTimeout.Config()).toEqual({ firstChunkIdleTimeoutMs: 120_000, maxFirstChunkCompactionRetries: 100 })
  })

  it('resolves the default through plugin application when config is omitted', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    FirstChunkTimeout.apply(ctx)
    const source = scriptedStream([{ result: { done: true, value: undefined } }])

    await expect(firstResult(waterfall(ctx, source))).resolves.toEqual({ done: true, value: undefined })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, MAX_TIMER_DELAY_MS + 1])(
    'rejects invalid firstChunkIdleTimeoutMs %s at load',
    async (firstChunkIdleTimeoutMs) => {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs })).rejects.toThrow(/firstChunkIdleTimeoutMs/u)
    },
  )

  it('rejects invalid direct application when schema normalization is bypassed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    expect(() => { FirstChunkTimeout.apply(ctx, { firstChunkIdleTimeoutMs: Number.NaN }) }).toThrow(/firstChunkIdleTimeoutMs/u)
  })

  it('rejects invalid maxFirstChunkCompactionRetries at load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    expect(() => { FirstChunkTimeout.apply(ctx, { maxFirstChunkCompactionRetries: 0 }) }).toThrow(/maxFirstChunkCompactionRetries/u)
  })
})

describe('first-chunk idle timeout invariant companion', () => {
  it('registers and withdraws its empty runtime invariant', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const InvariantRegistry = (await import('@deepseek-ai/dsh-invariants')).default
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin((await import('../src/invariant.ts')))

    expect(() => ctx.invariants.register('@deepseek-ai/dsh-fork-llm-first-chunk-timeout', () => {}))
      .toThrow(/already registered/u)
    await fiber.dispose()
    await expect(ctx.plugin((await import('../src/invariant.ts'))).await()).resolves.toBeDefined()
  })
})

describe('first-chunk idle timeout Loader composition', () => {
  it('mounts, configures, and withdraws through a real Loader entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-llm-first-chunk-timeout-loader-'))
    loaderRoots.push(root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-fork-llm-first-chunk-timeout'",
      '  config:',
      '    firstChunkIdleTimeoutMs: 12',
      '',
    ].join('\n'))

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-fork-llm-first-chunk-timeout', FirstChunkTimeout],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-fork-llm-first-chunk-timeout')
    if (entry === undefined) throw new Error('Loader did not mount first-chunk timeout')
    expect([...ctx.loader.entries()].some(item => item.options.name === '@deepseek-ai/dsh-llm')).toBe(true)
    await entry.parent.remove(entry.options.id)
    expect([...ctx.loader.entries()].some(item => item.options.name === '@deepseek-ai/dsh-fork-llm-first-chunk-timeout')).toBe(false)
  })
})

describe('first-chunk compaction recovery (agent/request-error)', () => {
  class FakeCompaction extends CompactionEngine {
    readonly compactIfNeeded = vi.fn<CompactionEngine['compactIfNeeded']>().mockResolvedValue(null)
    readonly compactNow = vi.fn<CompactionEngine['compactNow']>().mockResolvedValue(null)
    readonly compactRegion = vi.fn<CompactionEngine['compactRegion']>()
  }

  function fireError(
    ctx: Context,
    agent: { readonly session: { readonly surface: { replaceGeneration: number } }; readonly options: object },
    failure: { readonly message: string; readonly code: string },
    next: () => Promise<RequestErrorAction>,
    signal: AbortSignal = new AbortController().signal,
    position: { readonly turn: number; readonly step: number } = { turn: 1, step: 1 },
  ): Promise<RequestErrorAction> {
    return ctx.waterfall(ctx as never, 'agent/request-error', {
      agent,
      turn: position.turn,
      step: position.step,
      provider: 'provider',
      failure,
      retryPolicy: undefined,
      signal,
    } as never, next)
  }

  function delegated(): Promise<RequestErrorAction> {
    return Promise.resolve('delegated' as unknown as RequestErrorAction)
  }

  it('ends the timed-out request and follows up with continue after a successful compaction', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {}, followup: vi.fn() }
    const fake = new FakeCompaction(ctx)
    fake.compactIfNeeded.mockImplementation(async () => { surface.replaceGeneration += 1; return null })

    const result = await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated)
    expect(result).toBeUndefined()
    expect(fake.compactIfNeeded).toHaveBeenCalledTimes(1)
    expect(fake.compactIfNeeded).toHaveBeenCalledWith(agent, 'context-overflow', expect.any(AbortSignal))
    expect(agent.followup).not.toHaveBeenCalled()
    emitAgentStatus(ctx, agent, 'idle')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'plugin', plugin: 'fork-llm-first-chunk-timeout' },
    }))
  })

  it('prefers the compaction service mounted inside the agent preset', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {}, followup: vi.fn(), ctx }
    const host = new FakeCompaction(ctx)
    const scoped = {
      compactIfNeeded: vi.fn<CompactionEngine['compactIfNeeded']>().mockImplementation(async () => {
        surface.replaceGeneration += 1
        return null
      }),
    }
    const serviceFor = vi.fn().mockReturnValue(scoped)
    ctx.provide('agentPresets', { serviceFor } as never)

    const result = await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated)

    expect(result).toBeUndefined()
    expect(serviceFor).toHaveBeenCalledWith(agent, 'compaction')
    expect(scoped.compactIfNeeded).toHaveBeenCalledTimes(1)
    expect(host.compactIfNeeded).not.toHaveBeenCalled()
  })

  it('wakes a real agent driver with continue after the failed turn reaches idle', async () => {
    class RecoveryAdapter extends LlmAdapter {
      readonly requests: GenerateOptions[] = []

      async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(request)
        if (this.requests.length === 1) {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'resumed' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'resumed' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 5 })
    const fake = new FakeCompaction(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new RecoveryAdapter()
    ctx.llm.registerAdapter(['recovery'], adapter)
    const agent = ctx.agentLoop.create(SessionId('first-chunk-followup-driver'), {
      provider: 'recovery',
      model: 'recovery',
    })
    fake.compactIfNeeded.mockImplementation(async () => {
      const nodes = agent.session.surface.nodes
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'compacted history' }],
        source: { kind: 'plugin', plugin: 'test-compaction' },
      }), {
        surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
        sourceEventSeqs: [...nodes],
      })
      return null
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'start' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'plugin', plugin: 'fork-llm-first-chunk-timeout' },
    }))
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
      .toEqual(['error', 'completed'])
  })

  it('delegates when compaction makes no durable progress', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {}, followup: vi.fn() }
    const fake = new FakeCompaction(ctx)

    const next = vi.fn(delegated)
    const result = await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, next)
    expect(result).toBe('delegated')
    expect(next).toHaveBeenCalledTimes(1)
    expect(fake.compactIfNeeded).toHaveBeenCalledTimes(1)
    expect(surface.replaceGeneration).toBe(0)
  })

  it('delegates a non-first-chunk code through next()', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const agent = { session: { surface: { replaceGeneration: 0 } }, options: {} }
    const fake = new FakeCompaction(ctx)

    const result = await fireError(ctx, agent, { message: 'upstream 502', code: 'SERVER' }, delegated)
    expect(result).toBe('delegated')
    expect(fake.compactIfNeeded).not.toHaveBeenCalled()
  })

  it('delegates through next() when no compaction engine is installed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const agent = { session: { surface: { replaceGeneration: 0 } }, options: {} }

    const result = await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated)
    expect(result).toBe('delegated')
  })

  it('gives up after maxFirstChunkCompactionRetries and vetoes the chain', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10, maxFirstChunkCompactionRetries: 2 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {}, followup: vi.fn() }
    const fake = new FakeCompaction(ctx)
    fake.compactIfNeeded.mockImplementation(async () => { surface.replaceGeneration += 1; return null })

    const outcomes: Array<unknown> = []
    for (let i = 0; i < 3; i += 1) {
      outcomes.push(await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated))
      emitAgentStatus(ctx, agent, 'idle')
    }
    expect(outcomes).toEqual([undefined, undefined, undefined])
    expect(fake.compactIfNeeded).toHaveBeenCalledTimes(2)
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })

  it('bounds consecutive compaction follow-ups across their new turns', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10, maxFirstChunkCompactionRetries: 2 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {}, followup: vi.fn() }
    const fake = new FakeCompaction(ctx)
    fake.compactIfNeeded.mockImplementation(async () => { surface.replaceGeneration += 1; return null })

    for (let turn = 1; turn <= 3; turn += 1) {
      await fireError(
        ctx,
        agent,
        { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' },
        delegated,
        new AbortController().signal,
        { turn, step: 1 },
      )
      emitAgentStatus(ctx, agent, 'idle')
    }

    expect(fake.compactIfNeeded).toHaveBeenCalledTimes(2)
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })

  it('allows the default recovery ceiling to pass the fourth continuation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {}, followup: vi.fn() }
    const fake = new FakeCompaction(ctx)
    fake.compactIfNeeded.mockImplementation(async () => { surface.replaceGeneration += 1; return null })

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await fireError(
        ctx,
        agent,
        { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' },
        delegated,
      )
      emitAgentStatus(ctx, agent, 'idle')
    }

    expect(fake.compactIfNeeded).toHaveBeenCalledTimes(4)
    expect(agent.followup).toHaveBeenCalledTimes(4)
  })

  it('delegates through next() when the signal is already aborted', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const agent = { session: { surface: { replaceGeneration: 0 } }, options: {} }
    const fake = new FakeCompaction(ctx)
    const controller = new AbortController()
    controller.abort()

    const result = await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated, controller.signal)
    expect(result).toBe('delegated')
    expect(fake.compactIfNeeded).not.toHaveBeenCalled()
  })

  it('delegates through next() when the signal aborts during compaction', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {}, followup: vi.fn() }
    const fake = new FakeCompaction(ctx)
    const controller = new AbortController()
    fake.compactIfNeeded.mockImplementation(async () => { controller.abort(); return null })

    const result = await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated, controller.signal)
    expect(result).toBe('delegated')
    expect(fake.compactIfNeeded).toHaveBeenCalledTimes(1)
  })

  it('follows up when compaction throws after durable surface progress', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {}, followup: vi.fn() }
    const fake = new FakeCompaction(ctx)
    fake.compactIfNeeded.mockImplementation(async () => { surface.replaceGeneration += 1; throw new Error('summary failed') })

    const result = await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated)
    expect(result).toBeUndefined()
    expect(fake.compactIfNeeded).toHaveBeenCalledTimes(1)
    expect(agent.followup).not.toHaveBeenCalled()
    emitAgentStatus(ctx, agent, 'idle')
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('delegates when compaction throws without durable progress', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const agent = { session: { surface: { replaceGeneration: 0 } }, options: {} }
    const fake = new FakeCompaction(ctx)
    fake.compactIfNeeded.mockRejectedValue('summary failed')

    const next = vi.fn(delegated)
    const result = await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, next)
    expect(result).toBe('delegated')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('drops per-agent bookkeeping after the recovery follow-up activity turns idle', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10, maxFirstChunkCompactionRetries: 1 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {}, followup: vi.fn() }
    const fake = new FakeCompaction(ctx)
    fake.compactIfNeeded.mockImplementation(async () => { surface.replaceGeneration += 1; return null })
    await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated)

    emitAgentStatus(ctx, agent, 'idle')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    emitAgentStatus(ctx, agent, 'running')
    emitAgentStatus(ctx, agent, 'idle')

    await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated)
    emitAgentStatus(ctx, agent, 'idle')
    expect(fake.compactIfNeeded).toHaveBeenCalledTimes(2)
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })

  it('vetoes the chain when the signal aborts during a throwing compaction', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FirstChunkTimeout, { firstChunkIdleTimeoutMs: 10 })
    const surface = { replaceGeneration: 0 }
    const agent = { session: { surface }, options: {} }
    const fake = new FakeCompaction(ctx)
    const controller = new AbortController()
    fake.compactIfNeeded.mockImplementation(async () => { controller.abort(); throw new Error('summary failed') })

    const result = await fireError(ctx, agent, { message: 'first LLM chunk idle timeout', code: 'FIRST_CHUNK_TIMEOUT' }, delegated, controller.signal)
    expect(result).toBeUndefined()
    expect(fake.compactIfNeeded).toHaveBeenCalledTimes(1)
  })
})
