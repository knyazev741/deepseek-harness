/** Deterministic provider adapter for forced first-chunk compaction recovery. */

import {
  LlmAdapter,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'

class FirstChunkPressureSnapshotAdapter extends LlmAdapter {
  conversationRequests = 0
  policy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    retryableCodes: ['FIRST_CHUNK_TIMEOUT'],
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'first-chunk-pressure-snapshot-backend.retryPolicy')

  providerRetryPolicy() {
    return this.policy
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128_000 },
    })
  }

  async * stream(options) {
    if (options.purpose === 'session-title') {
      const title = 'First chunk recovery'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (options.purpose === 'compaction') {
      const summary = 'Recovered timeout context.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: summary }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    this.conversationRequests++
    if (this.conversationRequests === 1) {
      const call = {
        type: 'tool-call',
        id: 'call_first_chunk_marker',
        name: 'bash',
        arguments: JSON.stringify({
          command: "printf 'first-chunk-marker\\n'",
          description: 'Emit first chunk recovery marker',
        }),
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'usage', usage: { inputTokens: 24, outputTokens: 6 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (this.conversationRequests === 2) {
      await new Promise(resolve => setTimeout(resolve, 100))
      return
    }
    const messages = JSON.stringify(options.messages)
    if (!messages.includes('continue') || !messages.includes('Recovered timeout context.')) {
      throw new Error('first-chunk continuation did not use the compacted surface')
    }
    const text = 'FIRST_CHUNK_CONTINUE_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis plugin name. */
export const name = 'first-chunk-pressure-snapshot-backend'
/** Required LLM registry service. */
export const inject = ['llm']

/**
 * Register the deterministic provider adapter.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the LLM service.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new FirstChunkPressureSnapshotAdapter())
}
