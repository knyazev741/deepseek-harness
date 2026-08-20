/**
 * Authenticated loopback Streamable HTTP MCP gateway for one external
 * Harness session. The gateway snapshots an allowlisted, external-eligible
 * tool set and sends every call through `ctx.tools.execute` with the caller's
 * `ExternalToolPrincipal`; it never invokes a `ToolDefinition` directly.
 *
 * @module @deepseek-ai/dsh-mcp-gateway
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { CallId } from '@deepseek-ai/dsh-llm'
import type {
  ExternalToolPrincipal,
  ToolDefinition,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  ExternalToolCallId,
  type ExternalToolCallRecord,
  type ExternalToolResultRecord,
} from '@deepseek-ai/dsh-external-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { CallToolRequest, ListToolsResult, CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpGatewayCreateRequest, McpGatewayLease, McpGatewayService } from './types.ts'
import type { Config } from './types.ts'
import './types.ts'

export type { Config, McpGatewayCreateRequest, McpGatewayLease, McpGatewayService } from './types.ts'

/** Cordis plugin/service name. */
export const name = 'mcp-gateway'

/** Services needed for route registration and tool-pipeline dispatch. */
export const inject = ['webServer', 'tools']

/** Default request-body UTF-8 byte budget. */
export const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024
/** Default cooperative call deadline. */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000

const ROUTE_PREFIX = '/mcp/'
const MAX_ROUTE_BYTES = 80

/** Explicit environment variable used by the Codex consumer for the bearer token. */
export const MCP_BEARER_TOKEN_ENV_VAR = 'DSH_MCP_BEARER_TOKEN'

interface ResolvedConfig {
  readonly allowlist: ReadonlySet<string>
  readonly maxRequestBytes: number
  readonly executionTimeoutMs: number
}

interface ToolEntry {
  readonly definition: ToolDefinition
  readonly schema: ListToolsResult['tools'][number]
}

interface McpConnection {
  readonly server: { close(): Promise<void> }
  readonly transport: StreamableHTTPServerTransport
  sessionId?: string
  closed: boolean
}

interface RequestSignal {
  readonly signal: AbortSignal
  dispose(): void
}

/** Typed error used for malformed requests before MCP dispatch. */
class GatewayRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'GatewayRequestError'
  }
}

/** Resolve and validate deployment configuration at the service boundary. */
function resolveConfig(config: Config): ResolvedConfig {
  const allowlist = config.allowlist ?? []
  const names = new Set<string>()
  for (const name of allowlist) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('mcp-gateway: allowlist names must be non-empty strings')
    }
    if (names.has(name)) throw new Error(`mcp-gateway: duplicate allowlist tool "${name}"`)
    names.add(name)
  }
  const maxRequestBytes = config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new Error('mcp-gateway: maxRequestBytes must be a positive safe integer')
  }
  const executionTimeoutMs = config.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS
  if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs <= 0 || executionTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`mcp-gateway: executionTimeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return Object.freeze({
    allowlist: names,
    maxRequestBytes,
    executionTimeoutMs,
  })
}

/** Return a plain object suitable for an MCP input schema. */
function inputSchema(definition: ToolDefinition): ListToolsResult['tools'][number]['inputSchema'] {
  const candidate = definition.parameters
  if (candidate.type === 'object') {
    return candidate as ListToolsResult['tools'][number]['inputSchema']
  }
  return { type: 'object', properties: {} }
}

/** Convert one Harness schema to the MCP tool advertisement. */
function toolSchema(definition: ToolDefinition): ListToolsResult['tools'][number] {
  const output = definition.output.schema
  const outputSchema = output.type === 'object'
    ? output as ListToolsResult['tools'][number]['outputSchema']
    : undefined
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: inputSchema(definition),
    ...outputSchema === undefined ? {} : { outputSchema },
  }
}

/** Convert a bearer header using a length-safe comparison. */
function validBearer(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header)
  if (match === null) return false
  const supplied = Buffer.from(match[1] as string, 'utf8')
  const secret = Buffer.from(expected, 'utf8')
  return supplied.length === secret.length && timingSafeEqual(supplied, secret)
}

/** Send one bounded error without exposing route or token data. */
function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
  })
  res.end(JSON.stringify({ error: message }))
}

/** Read one request body with exact UTF-8 and byte bounds. */
async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new GatewayRequestError(415, 'content type must be application/json')
  }
  const lengthHeader = req.headers['content-length']
  if (lengthHeader !== undefined) {
    if (!/^\d+$/u.test(lengthHeader)) throw new GatewayRequestError(400, 'invalid content length')
    const declared = Number(lengthHeader)
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw new GatewayRequestError(413, 'request body is too large')
    }
  }
  const chunks: Buffer[] = []
  let bytes = 0
  let settled = false
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const body = new Promise<Buffer>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, bytes))
    }
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > maxBytes) {
        req.destroy()
        fail(new GatewayRequestError(413, 'request body is too large'))
        return
      }
      chunks.push(buffer)
    })
    req.once('end', finish)
    req.once('aborted', () => { fail(new GatewayRequestError(408, 'request body was aborted')) })
    req.once('error', (error) => { fail(error instanceof Error ? error : new Error(String(error))) })
    onAbort = (): void => {
      req.destroy()
      fail(new GatewayRequestError(408, 'request body was aborted'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      req.destroy()
      fail(new GatewayRequestError(408, 'request body timed out'))
    }, timeoutMs)
    timer.unref()
  })
  try {
    const bytesValue = await body
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytesValue)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new GatewayRequestError(400, 'request body is not one JSON value')
    }
  } catch (error: unknown) {
    if (error instanceof GatewayRequestError) throw error
    throw new GatewayRequestError(400, 'request body could not be read')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Return a request-scoped signal with lease, transport, and deadline cancellation. */
function requestSignal(parent: AbortSignal, lease: AbortSignal, timeoutMs: number): RequestSignal {
  const controller = new AbortController()
  const abort = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason)
  }
  const onParentAbort = (): void => { abort(parent) }
  const onLeaseAbort = (): void => { abort(lease) }
  if (parent.aborted) abort(parent)
  else parent.addEventListener('abort', onParentAbort, { once: true })
  if (lease.aborted) abort(lease)
  else lease.addEventListener('abort', onLeaseAbort, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error('MCP tool call timed out')) }, timeoutMs)
  timer.unref()
  controller.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clearTimeout(timer)
    parent.removeEventListener('abort', onParentAbort)
    lease.removeEventListener('abort', onLeaseAbort)
  }
  return { signal: controller.signal, dispose }
}

/** Map Harness content to the MCP content vocabulary without forwarding host-only refs. */
function mcpContent(blocks: readonly ContentBlock[]): CallToolResult['content'] {
  return blocks.map((block): CallToolResult['content'][number] => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'image':
        return {
          type: 'text',
          text: '[image result is stored by the Harness attachment service]',
        }
      case 'reasoning':
        return { type: 'text', text: block.text }
      case 'tool-call':
      case 'tool-result':
        return { type: 'text', text: JSON.stringify(block) }
      default:
        return { type: 'text', text: JSON.stringify(block) }
    }
  })
}

/** Convert one completed Harness tool result to an MCP result. */
function mcpResult(result: ToolExecutionResult): CallToolResult {
  if (result.isError) {
    return {
      content: mcpContent(result.content),
      isError: true,
    }
  }
  const value = result.value
  const structuredContent = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
  return {
    content: mcpContent(result.content),
    ...structuredContent === undefined ? {} : { structuredContent },
  }
}

/** Build one bounded recorder error for an unexpected executor throw. */
function thrownResult(error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
}

/** Return an MCP JSON-RPC request id as a stable call correlation suffix. */
function callIdFor(requestId: unknown): string {
  return `mcp-${typeof requestId === 'string' || typeof requestId === 'number' ? String(requestId) : 'notification'}-${randomUUID()}`
}

/** One live authenticated endpoint and its stateful MCP transports. */
class GatewayLease implements McpGatewayLease {
  readonly url: string
  readonly bearerToken: string
  private readonly controller = new AbortController()
  private readonly connections = new Map<string, McpConnection>()
  private readonly pendingConnections = new Set<McpConnection>()
  private readonly active = new Set<Promise<void>>()
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly principal: ExternalToolPrincipal,
    private readonly entries: ReadonlyMap<string, ToolEntry>,
    private readonly maxRequestBytes: number,
    private readonly executionTimeoutMs: number,
    path: string,
    private readonly releaseRoute: () => void,
    signal: AbortSignal,
  ) {
    this.url = `http://127.0.0.1:${String(ctx.webServer.port)}${path}`
    this.bearerToken = randomBytes(32).toString('base64url')
    if (signal.aborted) {
      this.disposed = true
      this.controller.abort(signal.reason)
    } else {
      signal.addEventListener('abort', () => { void this[Symbol.asyncDispose]() }, { once: true })
    }
  }

  /** Handle one authenticated Streamable HTTP request. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.disposed) {
      sendError(res, 404, 'MCP endpoint is unavailable')
      return
    }
    // Authentication is intentionally the first operation: no method,
    // content-type, body, or MCP parser runs for an unauthenticated request.
    if (!validBearer(headerString(req.headers.authorization), this.bearerToken)) {
      sendError(res, 401, 'authorization required')
      return
    }
    // Start the operation in a microtask before tracking it.  This closes the
    // synchronous-dispatch window in which disposal could otherwise observe an
    // empty active set and release the route while the handler was still being
    // entered.
    const operation = Promise.resolve().then(() => this.handleAuthenticated(req, res))
    this.active.add(operation)
    try {
      await operation
    } catch (error: unknown) {
      if (error instanceof GatewayRequestError) {
        sendError(res, error.status, error.message)
        return
      }
      sendError(res, 400, 'MCP request could not be handled')
    } finally {
      this.active.delete(operation)
    }
  }

  /** Dispose routes, abort calls, and close every stateful MCP transport. */
  [Symbol.asyncDispose](): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposal = this.disposeImpl()
    return this.disposal
  }

  private async disposeImpl(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.controller.abort(new Error('MCP gateway lease disposed'))
      this.releaseRoute()
    }
    const active = [...this.active]
    await Promise.allSettled(active)
    const connections = [...this.connections.values()]
    this.connections.clear()
    const pending = [...this.pendingConnections]
    this.pendingConnections.clear()
    const owned = [...new Set([...connections, ...pending])]
    for (const connection of owned) {
      connection.closed = true
      await connection.server.close().catch(() => {})
      await connection.transport.close().catch(() => {})
    }
  }

  private async handleAuthenticated(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = headerString(req.headers['mcp-session-id'])
    if (sessionId !== undefined && !this.connections.has(sessionId)) {
      sendError(res, 404, 'MCP session is not owned by this endpoint')
      return
    }
    switch (req.method) {
      case 'POST': {
        const body = await readJsonBody(req, this.maxRequestBytes, this.executionTimeoutMs, this.controller.signal)
        if (!isPlainRecord(body)) throw new GatewayRequestError(400, 'MCP request must be a JSON object')
        if (sessionId === undefined && !isInitializeRequest(body)) {
          throw new GatewayRequestError(400, 'MCP initialization is required before a session request')
        }
        const connection = sessionId === undefined
          ? await this.createConnection()
          : this.connections.get(sessionId)
        if (connection === undefined) throw new GatewayRequestError(404, 'MCP session is not owned by this endpoint')
        if (this.disposed) throw new GatewayRequestError(404, 'MCP endpoint is unavailable')
        await connection.transport.handleRequest(req, res, body)
        return
      }
      case 'GET':
      case 'DELETE': {
        if (sessionId === undefined) throw new GatewayRequestError(400, 'MCP session id is required')
        const connection = this.connections.get(sessionId)
        if (connection === undefined) throw new GatewayRequestError(404, 'MCP session is not owned by this endpoint')
        await connection.transport.handleRequest(req, res)
        return
      }
      default:
        res.setHeader('allow', 'GET, POST, DELETE')
        sendError(res, 405, 'MCP method is not supported')
    }
  }

  private async createConnection(): Promise<McpConnection> {
    if (this.disposed) throw new GatewayRequestError(404, 'MCP endpoint is unavailable')
    const connectionRef: { value?: McpConnection } = {}
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        const connection = connectionRef.value
        if (connection === undefined || this.disposed) return
        connection.sessionId = sessionId
        this.pendingConnections.delete(connection)
        this.connections.set(sessionId, connection)
      },
    })
    // The low-level Server is required here because the gateway supplies a
    // prevalidated JSON Schema and a custom pipeline handler for each call.
    // The SDK's high-level McpServer would reinterpret those schemas through
    // Zod and would not preserve the Harness execution identity.
    // oxlint-disable-next-line typescript/no-deprecated -- low-level handlers preserve raw Harness JSON Schemas and execution identity.
    const server = new Server(
      { name: 'dsh-mcp-gateway', version: '0.1.0' },
      { capabilities: { tools: {} } },
    )
    const connection: McpConnection = { server, transport, closed: false }
    connectionRef.value = connection
    this.pendingConnections.add(connection)
    transport.onclose = () => {
      connection.closed = true
      this.pendingConnections.delete(connection)
      if (connection.sessionId !== undefined && this.connections.get(connection.sessionId) === connection) {
        this.connections.delete(connection.sessionId)
      }
    }
    transport.onerror = (error: Error) => { this.ctx.logger.warn(`mcp-gateway: MCP transport failed: ${error.message}`) }
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.entries.values()].map(entry => entry.schema),
    }))
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => this.callTool(request, extra))
    try {
      await server.connect(transport as unknown as Transport)
    } catch (error: unknown) {
      this.pendingConnections.delete(connection)
      await server.close().catch(() => {})
      await transport.close().catch(() => {})
      throw error
    }
    return connection
  }

  private async callTool(
    request: CallToolRequest,
    extra: RequestHandlerExtra<never, never>,
  ): Promise<CallToolResult> {
    const name = request.params.name
    const entry = this.entries.get(name)
    if (entry === undefined) throw new Error(`unknown or unlisted MCP tool ${JSON.stringify(name)}`)
    const current = this.ctx.tools.get(name, this.principal)
    if (current !== entry.definition) throw new Error(`MCP tool ${JSON.stringify(name)} is no longer available`)
    const callId = ExternalToolCallId(callIdFor(extra.requestId))
    const args = request.params.arguments ?? {}
    const callRecord: ExternalToolCallRecord = { callId, name, arguments: args }
    const recorder = this.principal.recorder
    if (recorder.recordCall === undefined || recorder.recordResult === undefined) {
      throw new Error('external tool recorder is unavailable')
    }
    await recorder.recordCall(callRecord)
    let result: ToolExecutionResult
    const requestSignalState = requestSignal(extra.signal, this.controller.signal, this.executionTimeoutMs)
    try {
      result = await this.ctx.tools.execute({
        callId: CallId(String(callId)),
        name,
        arguments: args,
        principal: this.principal,
        signal: requestSignalState.signal,
      })
    } catch (error: unknown) {
      result = thrownResult(error)
    } finally {
      requestSignalState.dispose()
    }
    const resultRecord: ExternalToolResultRecord = result.isError
      ? { callId, name, isError: true, error: result.error }
      : { callId, name, isError: false, result: result.value }
    await recorder.recordResult(resultRecord)
    return mcpResult(result)
  }
}

/** A header value narrowed from Node's string/string[] union. */
function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Runtime plain-object check at the parsed JSON boundary. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Gateway service/provider registered in the host Cordis composition. */
export class McpGateway extends Service implements McpGatewayService {
  static inject = ['webServer', 'tools']

  static Config: z<Config> = z.object({
    allowlist: z.array(z.string()).default([]),
    maxRequestBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_REQUEST_BYTES),
    executionTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_EXECUTION_TIMEOUT_MS),
  }) as unknown as z<Config>

  private readonly config: ResolvedConfig
  private readonly routes = new Set<string>()
  private readonly leases = new Set<GatewayLease>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mcpGateway')
    this.config = resolveConfig(config)
    if (ctx.webServer.host !== '127.0.0.1') {
      throw new Error('mcp-gateway requires the WebServer host to be 127.0.0.1')
    }
    ctx.effect(() => async () => {
      const leases = [...this.leases]
      await Promise.allSettled(leases.map(lease => lease[Symbol.asyncDispose]()))
    }, 'mcpGateway.leases')
  }

  /** Create one authenticated route with a frozen definition set. */
  async create(request: McpGatewayCreateRequest): Promise<McpGatewayLease> {
    if (request.signal.aborted) throw new Error('mcp-gateway: attachment signal is already aborted')
    const entries = new Map<string, ToolEntry>()
    for (const name of request.tools) {
      if (!this.config.allowlist.has(name) || entries.has(name)) continue
      const definition = this.ctx.tools.get(name, request.principal)
      if (definition === undefined || definition.externalEligibility !== 'allow') continue
      entries.set(name, { definition, schema: toolSchema(definition) })
    }

    const path = `${ROUTE_PREFIX}${randomBytes(24).toString('base64url')}`
    if (path.length > MAX_ROUTE_BYTES || this.routes.has(path)) {
      throw new Error('mcp-gateway: generated route is already reserved')
    }
    this.routes.add(path)
    let released = false
    const leaseRef: { value?: GatewayLease } = {}
    let disposer: (() => void) | undefined
    const releaseRoute = (): void => {
      if (released) return
      released = true
      this.routes.delete(path)
      disposer?.()
      const lease = leaseRef.value
      if (lease !== undefined) this.leases.delete(lease)
    }
    const lease = new GatewayLease(
      this.ctx,
      request.principal,
      entries,
      this.config.maxRequestBytes,
      this.config.executionTimeoutMs,
      path,
      releaseRoute,
      request.signal,
    )
    leaseRef.value = lease
    this.leases.add(lease)
    try {
      const route: WebRoute = {
        kind: 'exact',
        path,
        handler: (req, res) => lease.handle(req, res),
      }
      disposer = this.ctx.webServer.register(route)
    } catch (error) {
      this.routes.delete(path)
      await lease[Symbol.asyncDispose]().catch(() => {})
      throw error
    }
    return lease
  }
}

export default McpGateway
