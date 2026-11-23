import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@knyazevai/dsh-llm'
import { describe, expect, it } from 'vitest'

function waitingAdapter() {
  const started = Promise.withResolvers<AbortSignal>()
  const stopped = Promise.withResolvers<undefined>()
  const adapter = new class extends LlmAdapter {
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const signal = options.signal
      if (signal === undefined) throw new Error('missing request cancellation')
      started.resolve(signal)
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: 'request cancelled', code: 'ABORTED' } },
        }
      } finally {
        stopped.resolve(undefined)
      }
    }
  }()
  return { adapter, started, stopped }
}

describe('model request cancellation', () => {
  it('keeps caller-owned history mutable when only the request object is frozen', async () => {
    const ctx = new Context()
    const messages: GenerateOptions['messages'] = []
    const request = Object.freeze({ provider: 'test', model: 'test', messages })
    let dispatched: GenerateOptions | undefined
    try {
      await ctx.plugin(LlmRuntime)
      ctx.effect(() => ctx.llm.registerAdapter(['test'], new class extends LlmAdapter {
        async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          dispatched = options
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }()))
      for await (const _chunk of ctx.llm.stream(request)) { /* drain */ }
      expect(Object.isFrozen(dispatched)).toBe(true)
      expect(Object.isFrozen(messages)).toBe(false)
      expect(dispatched?.messages).toBe(messages)
      expect(request).not.toHaveProperty('signal')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels an abandoned provider before a middleware timeout is consumed', async () => {
    const ctx = new Context()
    const caller = new AbortController()
    const provider = waitingAdapter()
    let pending: Promise<IteratorResult<StreamChunk>> | undefined
    let downstream: AsyncIterator<StreamChunk> | undefined
    const failure: StreamChunk = {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'FIRST_CHUNK_TIMEOUT', message: 'first chunk timed out' } },
    }
    try {
      await ctx.plugin(LlmRuntime)
      ctx.effect(() => ctx.llm.registerAdapter(['test'], provider.adapter))
      ctx.on('llm/stream', (_options, next) => {
        const iterator = next()[Symbol.asyncIterator]()
        downstream = iterator
        let emitted = false
        const stream: AsyncIterableIterator<StreamChunk> = {
          [Symbol.asyncIterator]() { return this },
          async next(): Promise<IteratorResult<StreamChunk>> {
            if (emitted) return { done: true, value: undefined }
            emitted = true
            pending = iterator.next()
            await provider.started.promise
            return { done: false, value: failure }
          },
        }
        return stream
      })
      const received: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({
        provider: 'test', model: 'test', messages: [], signal: caller.signal,
      })) received.push(chunk)

      expect(received).toEqual([failure])
      expect((await provider.started.promise).aborted).toBe(true)
      expect(caller.signal.aborted).toBe(false)
    } finally {
      caller.abort()
      await pending
      await downstream?.return?.()
      if (pending !== undefined) await provider.stopped.promise
      await ctx.fiber.dispose()
    }
  })

  it('cancels a pending provider read when the consumer returns without aborting its turn', async () => {
    const ctx = new Context()
    const caller = new AbortController()
    const provider = waitingAdapter()
    let read: Promise<IteratorResult<StreamChunk>> | undefined
    let closing: Promise<IteratorResult<StreamChunk>> | undefined
    try {
      await ctx.plugin(LlmRuntime)
      ctx.effect(() => ctx.llm.registerAdapter(['test'], provider.adapter))
      const iterator = ctx.llm.stream({
        provider: 'test', model: 'test', messages: [], signal: caller.signal,
      })[Symbol.asyncIterator]()
      read = iterator.next()
      const signal = await provider.started.promise
      closing = iterator.return?.()

      expect(signal.aborted).toBe(true)
      expect(caller.signal.aborted).toBe(false)
    } finally {
      caller.abort()
      await read
      await closing
      if (read !== undefined) await provider.stopped.promise
      await ctx.fiber.dispose()
    }
  })

  it('closes a stream before its first read without dispatching a provider', async () => {
    const ctx = new Context()
    let calls = 0
    try {
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['test'], new class extends LlmAdapter {
        async * stream(): AsyncIterable<StreamChunk> {
          calls += 1
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      const iterator = ctx.llm.stream({ provider: 'test', model: 'test', messages: [] })[Symbol.asyncIterator]()
      await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
      await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
      expect(calls).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves caller cancellation and closes the provider before consumer return settles', async () => {
    const ctx = new Context()
    const caller = new AbortController()
    const provider = waitingAdapter()
    let read: Promise<IteratorResult<StreamChunk>> | undefined
    let closing: Promise<IteratorResult<StreamChunk>> | undefined
    try {
      await ctx.plugin(LlmRuntime)
      ctx.effect(() => ctx.llm.registerAdapter(['test'], provider.adapter))
      const iterator = ctx.llm.stream({
        provider: 'test', model: 'test', messages: [], signal: caller.signal,
      })[Symbol.asyncIterator]()
      read = iterator.next()
      const signal = await provider.started.promise
      const reason = new Error('user cancelled')
      caller.abort(reason)
      expect(signal.reason).toBe(reason)
      closing = iterator.return?.()
      await closing
      await provider.stopped.promise
      await expect(read).resolves.toEqual({ done: true, value: undefined })
      expect(caller.signal.reason).toBe(reason)
    } finally {
      caller.abort()
      await read
      await closing
      if (read !== undefined) await provider.stopped.promise
      await ctx.fiber.dispose()
    }
  })

  it('rejects consumer failure before the first read without dispatching a provider', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      const iterator = ctx.llm.stream({ provider: 'absent', model: 'test', messages: [] })[Symbol.asyncIterator]()
      const failure = new Error('consumer failed')
      await expect(iterator.throw?.(failure)).rejects.toBe(failure)
      await expect(iterator.throw?.(failure)).rejects.toBe(failure)
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([true, false])('closes middleware without throw support and return support=%s', async (hasReturn) => {
    const ctx = new Context()
    const caller = new AbortController()
    const provider = waitingAdapter()
    let pending: Promise<IteratorResult<StreamChunk>> | undefined
    let downstream: AsyncIterator<StreamChunk> | undefined
    let returns = 0
    try {
      await ctx.plugin(LlmRuntime)
      ctx.effect(() => ctx.llm.registerAdapter(['test'], provider.adapter))
      ctx.on('llm/stream', (_options, next) => {
        const iterator = next()[Symbol.asyncIterator]()
        downstream = iterator
        const stream: AsyncIterableIterator<StreamChunk> = {
          [Symbol.asyncIterator]() { return this },
          async next(): Promise<IteratorResult<StreamChunk>> {
            pending = iterator.next()
            await provider.started.promise
            return { done: false, value: { type: 'text-delta', index: 0, text: 'progress' } }
          },
          ...(hasReturn ? {
            async return(): Promise<IteratorResult<StreamChunk>> {
              returns++
              return { done: true, value: undefined }
            },
          } : {}),
        }
        return stream
      })
      const iterator = ctx.llm.stream({
        provider: 'test', model: 'test', messages: [], signal: caller.signal,
      })[Symbol.asyncIterator]()
      await iterator.next()
      const failure = new Error('consumer failed')
      await expect(iterator.throw?.(failure)).rejects.toBe(failure)
      expect(returns).toBe(hasReturn ? 1 : 0)
      expect((await provider.started.promise).aborted).toBe(true)
      expect(caller.signal.aborted).toBe(false)
    } finally {
      caller.abort()
      await pending
      await downstream?.return?.()
      if (pending !== undefined) await provider.stopped.promise
      await ctx.fiber.dispose()
    }
  })

  it.each(['construction', 'iterator', 'iteration', 'return', 'throw'] as const)(
    'preserves middleware %s errors while cancelling abandoned adapter work',
    async (phase) => {
      const ctx = new Context()
      const caller = new AbortController()
      const provider = waitingAdapter()
      const failure = new Error(`${phase} failed`)
      let pending: Promise<IteratorResult<StreamChunk>> | undefined
      let downstream: AsyncIterator<StreamChunk> | undefined
      try {
        await ctx.plugin(LlmRuntime)
        ctx.effect(() => ctx.llm.registerAdapter(['test'], provider.adapter))
        ctx.on('llm/stream', (_options, next) => {
          const iterator = next()[Symbol.asyncIterator]()
          downstream = iterator
          pending = iterator.next()
          if (phase === 'construction') throw failure
          const stream: AsyncIterableIterator<StreamChunk> = {
            [Symbol.asyncIterator]() {
              if (phase === 'iterator') throw failure
              return this
            },
            async next(): Promise<IteratorResult<StreamChunk>> {
              await provider.started.promise
              if (phase === 'iteration') throw failure
              return { done: false, value: { type: 'text-delta', index: 0, text: 'progress' } }
            },
            return(): Promise<IteratorResult<StreamChunk>> { return Promise.reject(failure) },
            throw(): Promise<IteratorResult<StreamChunk>> { return Promise.reject(failure) },
          }
          return stream
        })
        const request = { provider: 'test', model: 'test', messages: [], signal: caller.signal }
        if (phase === 'construction') {
          expect(() => ctx.llm.stream(request)).toThrow(failure)
        } else {
          const iterator = ctx.llm.stream(request)[Symbol.asyncIterator]()
          if (phase === 'iteration' || phase === 'iterator') await expect(iterator.next()).rejects.toBe(failure)
          else {
            await iterator.next()
            const operation = phase === 'return' ? iterator.return?.() : iterator.throw?.(failure)
            await expect(operation).rejects.toBe(failure)
          }
        }
        expect((await provider.started.promise).aborted).toBe(true)
        expect(caller.signal.aborted).toBe(false)
      } finally {
        caller.abort()
        await pending
        await downstream?.return?.()
        if (pending !== undefined) await provider.stopped.promise
        await ctx.fiber.dispose()
      }
    },
  )
})
