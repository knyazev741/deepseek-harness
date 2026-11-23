/** Normalize a bounded non-streaming Chat Completion for the existing pi-ai SSE decoder. */
import { LlmError } from '@knyazevai/dsh-llm'
import { fetchWithStreamTimeout } from '@knyazevai/dsh-http-proxy'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(message: string, cause?: unknown): LlmError {
  return new LlmError(`Complete Chat Completions response: ${message}`, 'MALFORMED_RESPONSE', { cause })
}

function choiceChunk(value: unknown, index: number): Record<string, unknown> {
  if (!record(value) || !record(value['message'])) throw malformed(`choice ${index} has no assistant message`)
  const reason = value['finish_reason']
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new LlmError('Complete Chat Completions response ended without finish_reason', 'STREAM_CLOSED')
  }
  const message = value['message']
  if (message['role'] !== 'assistant') throw malformed(`choice ${index} is not an assistant message`)
  if (message['content'] !== undefined && message['content'] !== null && typeof message['content'] !== 'string') {
    throw malformed(`choice ${index} has invalid text content`)
  }
  const delta = { ...message }
  if (message['tool_calls'] !== undefined && message['tool_calls'] !== null) {
    if (!Array.isArray(message['tool_calls'])) throw malformed(`choice ${index} has invalid tool calls`)
    const calls: unknown[] = message['tool_calls']
    delta['tool_calls'] = calls.map((call, at) => {
      if (!record(call) || typeof call['id'] !== 'string' || call['id'].length === 0) {
        throw malformed(`choice ${index} tool ${at} has no id`)
      }
      const fn = call['type'] === 'function' ? call['function'] : call['type'] === 'custom' ? call['custom'] : undefined
      if (!record(fn) || typeof fn['name'] !== 'string' || fn['name'].length === 0
        || typeof fn[call['type'] === 'function' ? 'arguments' : 'input'] !== 'string') {
        throw malformed(`choice ${index} tool ${at} is incomplete`)
      }
      return { ...call, index: at }
    })
  }
  return { index: typeof value['index'] === 'number' ? value['index'] : index, delta, finish_reason: reason }
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw malformed('response body is absent')
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.byteLength
    if (total > maxBytes) throw malformed(`response exceeds the configured ${maxBytes} byte limit`)
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(total)
  let position = 0
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch (error) { throw malformed('response is not valid UTF-8 JSON', error) }
}

/**
 * Request one complete response without altering model inputs, then expose its confirmed result as SSE.
 * HTTP failures retain the original response for the provider SDK. Missing terminal reasons and
 * invalid response fields fail before any content reaches assembly or tool dispatch.
 * @param input - SDK request URL.
 * @param init - SDK JSON request and cancellation signal.
 * @param timeoutMs - HTTP idle deadline, also owned by the adapter's response watchdog.
 * @param maxBytes - maximum buffered response bytes.
 * @returns the original HTTP failure or the confirmed completion in SSE framing.
 */
export async function fetchCompleteResponse(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<Response> {
  if (typeof init?.body !== 'string') throw malformed('SDK request body is not a JSON string')
  let request: unknown
  try { request = JSON.parse(init.body) }
  catch (error) { throw malformed('SDK request body is not valid JSON', error) }
  if (!record(request)) throw malformed('SDK request body is not an object')
  const body = { ...request, stream: false }
  Reflect.deleteProperty(body, 'stream_options')
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  headers.delete('content-length')
  const response = await fetchWithStreamTimeout(input, { ...init, headers, body: JSON.stringify(body) }, timeoutMs)
  if (!response.ok) return response
  const value = await boundedJson(response, maxBytes)
  if (!record(value) || !Array.isArray(value['choices']) || value['choices'].length === 0) {
    throw malformed('response has no choices')
  }
  const choices: unknown[] = value['choices']
  const chunk = { ...value, object: 'chat.completion.chunk', choices: choices.map(choiceChunk) }
  const replyHeaders = new Headers(response.headers)
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) replyHeaders.delete(name)
  replyHeaders.set('content-type', 'text/event-stream')
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: response.status, statusText: response.statusText, headers: replyHeaders,
  })
}
