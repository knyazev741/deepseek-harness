import { createServer } from 'node:http'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http'

/** One request observed by the package-private Responses fixture. */
interface RecordedResponsesRequest {
  readonly method: string | undefined
  readonly path: string | undefined
  readonly headers: IncomingHttpHeaders
  readonly body: Record<string, unknown>
}

/** Behavior consumed by one Responses request. */
export type ResponsesBehavior =
  | { readonly kind: 'complete'; readonly text: string }
  | {
    readonly kind: 'functionCall'
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
  | {
    readonly kind: 'advertisedFunctionCall'
    readonly choices: readonly {
      readonly name: string
      readonly arguments: Record<string, unknown>
    }[]
  }
  | {
    readonly kind: 'mcpCall'
    readonly serverLabel: string
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
  | {
    /** A Responses function_call with the namespace Codex uses for regular MCP tools. */
    readonly kind: 'codexMcpCall'
    readonly namespace: string
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
  | { readonly kind: 'hold' }

/** Running package-private Responses fixture. */
export interface ResponsesFixture {
  readonly baseUrl: string
  readonly requests: RecordedResponsesRequest[]
  readonly requestStarted: Promise<void>
  /** Fail when a scripted Responses turn was not consumed by the scenario. */
  assertConsumed(): void
  close(): Promise<void>
}

/** Optional transport pacing for browser assertions of the live delta phase. */
export interface ResponsesFixtureOptions {
  /** Delay between SSE events; zero keeps the fixture as fast as possible. */
  readonly eventDelayMs?: number
  /**
   * Accept a null previous_response_id after the first response. The pinned
   * Codex app-server uses this stateless Responses continuation for its local
   * provider; non-null ids are still required to match the preceding response.
   */
  readonly allowStatelessContinuation?: boolean
}

function responseObject(text: string, suffix = '', previousResponseId: string | null = null): Record<string, unknown> {
  const message = {
    id: `msg_fixture${suffix}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{
      type: 'output_text',
      annotations: [],
      logprobs: [],
      text,
    }],
  }
  return {
    id: `resp_fixture${suffix}`,
    object: 'response',
    created_at: 1,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: 'fixture-model',
    output: [message],
    parallel_tool_calls: true,
    previous_response_id: previousResponseId,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: { effort: null, summary: null },
    safety_identifier: null,
    service_tier: 'default',
    store: false,
    temperature: null,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: null,
    truncation: 'disabled',
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 11,
    },
    user: null,
    metadata: {},
  }
}

/**
 * Build the minimal Responses SSE event sequence consumed by Codex 0.147.0.
 * @param text - exact assistant answer.
 * @param suffix - deterministic id suffix for one fixture request.
 * @param previousResponseId - prior response id for a chained request.
 * @returns ordered response lifecycle events.
 */
export function completeResponsesEvents(
  text: string,
  suffix = '',
  previousResponseId: string | null = null,
): Record<string, unknown>[] {
  const completed = responseObject(text, suffix, previousResponseId)
  const message = (completed.output as Record<string, unknown>[])[0]!
  const part = (message.content as Record<string, unknown>[])[0]!
  const midpoint = Math.ceil(text.length / 2)
  const deltas = text.length === 0 ? [''] : [text.slice(0, midpoint), text.slice(midpoint)]
  return [
    {
      type: 'response.created',
      response: { ...completed, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: '' },
    },
    ...deltas.map(delta => ({
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
    })),
    {
      type: 'response.output_text.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: 'response.content_part.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: message,
    },
    { type: 'response.completed', response: completed },
  ]
}

function functionCallEvents(
  name: string,
  argumentsValue: Record<string, unknown>,
  suffix = '',
  previousResponseId: string | null = null,
  namespace?: string,
): Record<string, unknown>[] {
  const argumentsText = JSON.stringify(argumentsValue)
  const item = {
    id: `fc_fixture${suffix}`,
    type: 'function_call',
    status: 'completed',
    ...namespace === undefined ? {} : { namespace },
    name,
    arguments: argumentsText,
    call_id: `call_fixture${suffix}`,
  }
  const completed = {
    ...responseObject('', suffix, previousResponseId),
    output: [item],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  }
  return [
    {
      type: 'response.created',
      response: { ...completed, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: item.id,
      output_index: 0,
      arguments: argumentsText,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item,
    },
    { type: 'response.completed', response: completed },
  ]
}

function mcpCallEvents(
  serverLabel: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  suffix = '',
  previousResponseId: string | null = null,
): Record<string, unknown>[] {
  const argumentsText = JSON.stringify(argumentsValue)
  const item = {
    id: `mcp_fixture${suffix}`,
    type: 'mcp_call',
    status: 'completed',
    server_label: serverLabel,
    name,
    arguments: argumentsText,
    output: '',
  }
  const completed = {
    ...responseObject('', suffix, previousResponseId),
    output: [item],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  }
  return [
    {
      type: 'response.created',
      response: { ...completed, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.mcp_call.in_progress',
      output_index: 0,
      item_id: item.id,
    },
    {
      type: 'response.mcp_call_arguments.delta',
      item_id: item.id,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: 'response.mcp_call_arguments.done',
      item_id: item.id,
      output_index: 0,
      arguments: argumentsText,
    },
    {
      type: 'response.mcp_call.completed',
      output_index: 0,
      item_id: item.id,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item,
    },
    { type: 'response.completed', response: completed },
  ]
}

function readRequest(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => { resolve(body) })
    request.on('error', reject)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

function collectAdvertisedFunctionNames(value: unknown, names: Set<string>, namespace?: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectAdvertisedFunctionNames(entry, names, namespace)
    return
  }
  if (value === null || typeof value !== 'object') return
  const object = value as Record<string, unknown>
  const type = object.type
  const name = object.name
  const nestedNamespace = type === 'namespace' && typeof name === 'string' ? name : namespace
  if ((type === 'function' || type === 'custom') && typeof name === 'string') {
    names.add(name)
    // Codex 0.147's `functions` namespace exposes the shell transport as
    // `exec` in `additional_tools`, while its Responses call name remains
    // `exec_command`.
    if (namespace === 'functions' && name === 'exec') names.add('exec_command')
  }
  for (const child of Object.values(object)) {
    collectAdvertisedFunctionNames(child, names, nestedNamespace)
  }
}

function advertisedFunctionNames(body: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  collectAdvertisedFunctionNames(body.tools, names)
  collectAdvertisedFunctionNames(body.input, names)
  return names
}

/** Return the local model roster queried by Codex before Responses turns. */
function fixtureModelsResponse(): Record<string, unknown> {
  return {
    object: 'list',
    data: [{
      id: 'fixture-model',
      model: 'fixture-model',
      displayName: 'Fixture Model',
      description: 'Deterministic loopback Responses model.',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', name: 'Low', description: 'Fixture low effort.' },
        { reasoningEffort: 'high', name: 'High', description: 'Fixture high effort.' },
      ],
      defaultReasoningEffort: 'low',
      inputModalities: ['text'],
    }],
    nextCursor: null,
  }
}

/**
 * Start a loopback-only Responses SSE fixture.
 * @param script - one behavior per expected Responses request.
 * @returns the running fixture and its observed requests.
 */
export async function startResponsesFixture(
  script: readonly ResponsesBehavior[],
  options: ResponsesFixtureOptions = {},
): Promise<ResponsesFixture> {
  const behaviors = [...script]
  const eventDelayMs = options.eventDelayMs ?? 0
  const allowStatelessContinuation = options.allowStatelessContinuation ?? false
  if (!Number.isFinite(eventDelayMs) || eventDelayMs < 0) {
    throw new Error(`responses fixture eventDelayMs must be a non-negative finite number, got ${String(eventDelayMs)}`)
  }
  const requests: RecordedResponsesRequest[] = []
  let lastResponseId: string | null = null
  const started = Promise.withResolvers<undefined>()
  const openResponses = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    openResponses.add(response)
    response.on('close', () => { openResponses.delete(response) })
    if (/\/models(?:\?|$)/u.test(request.url ?? '')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(fixtureModelsResponse()))
      return
    }
    void readRequest(request).then(async (body) => {
      const parsedBody = JSON.parse(body) as Record<string, unknown>
      requests.push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: parsedBody,
      })
      started.resolve(undefined)
      const previousResponseId = parsedBody.previous_response_id
      const previousResponseMatches = lastResponseId === null
        ? previousResponseId === undefined || previousResponseId === null
        : previousResponseId === lastResponseId
          || (allowStatelessContinuation && (previousResponseId === undefined || previousResponseId === null))
      if (!previousResponseMatches) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          error: {
            message: 'fixture request did not continue the previous response',
            expected_previous_response_id: lastResponseId,
            received_previous_response_id: previousResponseId ?? null,
          },
        }))
        return
      }
      const behavior = behaviors.shift()
      if (behavior === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'fixture script exhausted' } }))
        return
      }
      const advertisedCall = behavior.kind === 'advertisedFunctionCall'
        ? behavior.choices.find(choice => advertisedFunctionNames(parsedBody).has(choice.name))
        : undefined
      if (behavior.kind === 'advertisedFunctionCall' && advertisedCall === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'none of the fixture function calls was advertised' } }))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': 'req_fixture',
      })
      if (behavior.kind === 'hold') return
      const suffix = `_request${String(requests.length)}`
      let events: Record<string, unknown>[]
      if (behavior.kind === 'complete') {
        events = completeResponsesEvents(behavior.text, suffix, lastResponseId)
      } else if (behavior.kind === 'mcpCall') {
        events = mcpCallEvents(behavior.serverLabel, behavior.name, behavior.arguments, suffix, lastResponseId)
      } else if (behavior.kind === 'codexMcpCall') {
        events = functionCallEvents(
          behavior.name,
          behavior.arguments,
          suffix,
          lastResponseId,
          behavior.namespace,
        )
      } else {
        const call = behavior.kind === 'functionCall'
          ? behavior
          : advertisedCall!
        events = functionCallEvents(call.name, call.arguments, suffix, lastResponseId)
      }
      lastResponseId = `resp_fixture${suffix}`
      for (const event of events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
        if (eventDelayMs > 0) await new Promise(resolve => setTimeout(resolve, eventDelayMs))
      }
      response.end('data: [DONE]\n\n')
    }).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('responses fixture did not acquire a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    requestStarted: started.promise,
    assertConsumed(): void {
      if (behaviors.length > 0) {
        throw new Error(`responses fixture has ${String(behaviors.length)} unconsumed scripted request(s)`)
      }
    },
    async close(): Promise<void> {
      for (const response of openResponses) response.destroy()
      await closeServer(server)
    },
  }
}
