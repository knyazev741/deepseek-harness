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
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { CallId } from '@deepseek-ai/dsh-llm'
import type {
  ExternalToolPrincipal,
  ToolDefinition,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  ExternalToolCallId,
  MAX_EXTERNAL_TOOL_RECORD_BYTES,
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
/** Default MCP response/result UTF-8 byte budget. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024
/** Default cooperative call deadline. */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000

const ROUTE_PREFIX = '/mcp/'
const MAX_ROUTE_BYTES = 80

/** Explicit environment variable used by the Codex consumer for the bearer token. */
export const MCP_BEARER_TOKEN_ENV_VAR = 'DSH_MCP_BEARER_TOKEN'

interface ResolvedConfig {
  readonly allowlist: ReadonlySet<string>
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
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
  constructor(readonly status: number, readonly code: number, message: string) {
    super(message)
    this.name = 'GatewayRequestError'
  }
}

const MCP_ACCEPT_JSON = 'application/json'
const MCP_ACCEPT_EVENT_STREAM = 'text/event-stream'

/** Create one protocol-shaped error response before SDK dispatch. */
function sendMcpError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

/** Send a pre-parser failure using the MCP JSON-RPC envelope. */
function sendGatewayError(res: ServerResponse, error: GatewayRequestError): void {
  sendMcpError(res, error.status, error.code, error.message)
}

/** Require one Streamable HTTP Accept header before reading a request body. */
function requireAccept(req: IncomingMessage, method: 'GET' | 'POST'): void {
  const accept = headerString(req.headers.accept)
  const valid = method === 'GET'
    ? accept?.includes(MCP_ACCEPT_EVENT_STREAM) === true
    : accept?.includes(MCP_ACCEPT_JSON) === true && accept.includes(MCP_ACCEPT_EVENT_STREAM)
  if (!valid) {
    throw new GatewayRequestError(
      406,
      -32000,
      method === 'GET'
        ? 'Not Acceptable: Client must accept text/event-stream'
        : 'Not Acceptable: Client must accept both application/json and text/event-stream',
    )
  }
}

/** Require the JSON content type before reading a POST body. */
function requireJsonContentType(req: IncomingMessage): void {
  const contentType = headerString(req.headers['content-type'])
  if (contentType === undefined || !contentType.toLowerCase().includes('application/json')) {
    throw new GatewayRequestError(415, -32000, 'Unsupported Media Type: Content-Type must be application/json')
  }
}

/** Reject an explicitly unsupported protocol version after initialization detection. */
function requireSupportedProtocolVersion(req: IncomingMessage): void {
  const version = headerString(req.headers['mcp-protocol-version'])
  if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw new GatewayRequestError(
      400,
      -32000,
      `Bad Request: Unsupported protocol version: ${version} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
    )
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
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  if (!Number.isSafeInteger(maxResponseBytes)
    || maxResponseBytes < MIN_MAX_RESPONSE_BYTES
    || maxResponseBytes > MAX_EXTERNAL_TOOL_RECORD_BYTES) {
    throw new Error(`mcp-gateway: maxResponseBytes must be a safe integer from ${MIN_MAX_RESPONSE_BYTES} through ${MAX_EXTERNAL_TOOL_RECORD_BYTES}`)
  }
  const executionTimeoutMs = config.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS
  if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs <= 0 || executionTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`mcp-gateway: executionTimeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return Object.freeze({
    allowlist: names,
    maxRequestBytes,
    maxResponseBytes,
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
  const lengthHeader = req.headers['content-length']
  if (lengthHeader !== undefined) {
    if (!/^\d+$/u.test(lengthHeader)) throw new GatewayRequestError(400, -32000, 'invalid content length')
    const declared = Number(lengthHeader)
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw new GatewayRequestError(413, -32000, 'request body is too large')
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
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > maxBytes) {
        // Keep consuming the request so the server can send a deterministic
        // JSON-RPC response instead of turning chunked overflow into a reset.
        req.resume()
        fail(new GatewayRequestError(413, -32000, 'request body is too large'))
        return
      }
      chunks.push(buffer)
    })
    req.once('end', finish)
    req.once('aborted', () => { fail(new GatewayRequestError(408, -32000, 'request body was aborted')) })
    req.once('error', (error) => { fail(error instanceof Error ? error : new Error(String(error))) })
    onAbort = (): void => {
      req.resume()
      fail(new GatewayRequestError(408, -32000, 'request body was aborted'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      req.resume()
      fail(new GatewayRequestError(408, -32000, 'request body timed out'))
    }, timeoutMs)
    timer.unref()
  })
  try {
    const bytesValue = await body
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytesValue)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new GatewayRequestError(400, -32700, 'Parse error: Invalid JSON')
    }
  } catch (error: unknown) {
    if (error instanceof GatewayRequestError) throw error
    throw new GatewayRequestError(400, -32700, 'Parse error: Invalid JSON')
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

const REDACTED = '[REDACTED]'
const PATH_REDACTION = '[PATH REDACTED]'
const RESPONSE_LIMIT_MESSAGE = 'tool result exceeded the configured response limit'
const SECRET_TEXT_KEYS = [
  'api[-_ ]?key',
  'access[-_ ]?token',
  'auth(?:orization)?',
  'password',
  'passphrase',
  'secret',
  'token',
  '(?:bearer|refresh|session)[-_ ]?token',
  'credential(?:s)?',
  'cookie',
].join('|')
const SECRET_TEXT_PATTERN = new RegExp(
  `((?:["']?\\b(?:${SECRET_TEXT_KEYS})\\b["']?)\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`,
  'giu',
)
const LOCAL_PATH_PATTERN = new RegExp(
  String.raw`(?:\/(?:Users|home|private|tmp|var|opt)\/|[A-Za-z]:[\\/]|\\\\(?:Users|home|private|tmp|var|opt)\\)[^"'\x60<>\r\n]*`,
  'gu',
)
const SECRET_KEY_MARKERS = [
  'apikey',
  'accesstoken',
  'authtoken',
  'password',
  'passphrase',
  'secret',
  'secretkey',
  'token',
  'credential',
  'credentials',
  'privatekey',
  'signingkey',
  'encryptionkey',
  'authorization',
  'cookie',
  'setcookie',
  'auth',
  'bearer',
]
const SECRET_KEY_VALUE_SUFFIXES = ['value', 'text', 'string', 'data', 'raw', 'bytes', 'header', 'ref', 'reference', 'env', 'environment', 'key']

/**
 * Classify normalized credential-bearing key names conservatively.
 * A marker must be the whole name, a suffix, or be followed by a known
 * value-bearing qualifier such as `Value` or `Data`; ordinary names such as
 * `key`, `tokenCount`, and `secretary` remain intact.
 */
function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return SECRET_KEY_MARKERS.some(marker => normalized === marker
    || normalized.endsWith(marker)
    || SECRET_KEY_VALUE_SUFFIXES.some(suffix => normalized.includes(`${marker}${suffix}`)))
}

/** Redact bearer/secret fields and local paths before they leave the process. */
function redactText(value: string, bounded = true): string {
  const replaced = value
    .replace(/\bBearer\s+\S+/giu, `Bearer ${REDACTED}`)
    .replace(SECRET_TEXT_PATTERN, `$1${REDACTED}`)
    .replace(LOCAL_PATH_PATTERN, PATH_REDACTION)
  try {
    const parsed = JSON.parse(replaced) as unknown
    if (parsed !== null && typeof parsed === 'object') return safeJson(sanitizeJsonValue(parsed, 0, bounded))
  } catch {
    // Plain diagnostic text is handled by the replacements above.
  }
  const prefixedJson = /^(Error:\s*)(\{[\s\S]*\}|\[[\s\S]*\])$/u.exec(replaced)
  if (prefixedJson !== null) {
    try {
      return `${prefixedJson[1]}${safeJson(sanitizeJsonValue(JSON.parse(prefixedJson[2] as string) as unknown, 0, bounded))}`
    } catch {
      // Keep the bounded textual replacements when the suffix is not JSON.
    }
  }
  return replaced
}

/** Detach a JSON-compatible value while redacting strings and optional bounds. */
function sanitizeJsonValue(value: unknown, depth = 0, bounded = true): unknown {
  if (typeof value === 'string') return redactText(value, bounded)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (bounded && depth >= 12) return '[nested value omitted]'
  if (Array.isArray(value)) {
    const items = bounded ? value.slice(0, 256) : value
    return items.map(item => sanitizeJsonValue(item, depth + 1, bounded))
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    const allEntries = Object.entries(value as Record<string, unknown>)
    const entries = bounded ? allEntries.slice(0, 256) : allEntries
    for (const [key, item] of entries) {
      output[key] = isSecretKey(key) ? REDACTED : sanitizeJsonValue(item, depth + 1, bounded)
    }
    return output
  }
  return REDACTED
}

/** Serialize a value without allowing output diagnostics to throw. */
function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value)
    return encoded
  } catch {
    return JSON.stringify(REDACTED)
  }
}

type GatewayEventListener = (...args: unknown[]) => unknown

/** Dispatch one gateway observation without letting a subscriber break the owner operation. */
function emitContained(ctx: Context, name: string, payload?: unknown): unknown {
  const args = payload === undefined ? [name] : [name, payload]
  let callbacks: GatewayEventListener[]
  try {
    callbacks = ctx.events.dispatch('emit', args) as GatewayEventListener[]
  } catch (error: unknown) {
    ctx.logger.warn(`mcp-gateway: ${name} dispatch failed: ${listenerErrorMessage(error)}`)
    return error
  }
  let firstError: unknown
  for (const callback of callbacks) {
    try {
      const returned = callback(...payload === undefined ? [] : [payload])
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`mcp-gateway: ${name} listener rejected: ${listenerErrorMessage(error)}`)
      })
    } catch (error: unknown) {
      firstError ??= error
      ctx.logger.warn(`mcp-gateway: ${name} listener threw: ${listenerErrorMessage(error)}`)
    }
  }
  return firstError
}

/** Render observer failures without allowing error coercion to escape containment. */
function listenerErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unprintable listener error'
  }
}

/** Map Harness content to bounded MCP text blocks without host-only refs. */
function mcpContent(blocks: readonly ContentBlock[]): CallToolResult['content'] {
  return blocks.map((block): CallToolResult['content'][number] => {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        return { type: 'text', text: redactText(block.text) }
      case 'image':
        return { type: 'text', text: '[image result is stored by the Harness attachment service]' }
      case 'tool-call':
      case 'tool-result':
        return { type: 'text', text: safeJson(sanitizeJsonValue(block)) }
      default:
        return { type: 'text', text: safeJson(sanitizeJsonValue(block)) }
    }
  })
}

/** Convert one completed Harness tool result to a redacted MCP result. */
function mcpResult(result: ToolExecutionResult): CallToolResult {
  if (result.isError) {
    return { content: mcpContent(result.content), isError: true }
  }
  const value = sanitizeJsonValue(result.value)
  const structuredContent = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
  return {
    content: mcpContent(result.content),
    ...structuredContent === undefined ? {} : { structuredContent },
  }
}

/** Create the fixed MCP error used when a result exceeds the response budget. */
function responseLimitResult(): ToolExecutionResult {
  return {
    isError: true,
    error: { message: RESPONSE_LIMIT_MESSAGE },
    content: [{ type: 'text', text: RESPONSE_LIMIT_MESSAGE }],
  }
}

/** Minimum configured response budget that can carry the fixed MCP fallback. */
export const MIN_MAX_RESPONSE_BYTES = Buffer.byteLength(safeJson(mcpResult(responseLimitResult())), 'utf8')

/** Build one bounded recorder error for an unexpected executor throw. */
function thrownResult(error: unknown): ToolExecutionResult {
  let message: string
  try {
    const raw = error instanceof Error ? error.message : error
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown
        message = safeJson(sanitizeJsonValue(parsed))
      } catch {
        message = raw
      }
    } else {
      message = safeJson(sanitizeJsonValue(raw))
    }
  } catch {
    message = 'unprintable thrown value'
  }
  message = redactText(message)
  return {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
}

/** Redact a result before both durable recording and MCP projection. */
function sanitizeToolResult(result: ToolExecutionResult): ToolExecutionResult {
  if (result.isError) {
    const error = sanitizeJsonValue(result.error) as ToolExecutionResult['error']
    return { ...result, error } as ToolExecutionResult
  }
  return {
    ...result,
    value: sanitizeJsonValue(result.value) as typeof result.value,
  }
}

/** Enforce one response budget and return a deterministic terminal failure if needed. */
function boundToolResult(result: ToolExecutionResult, maxResponseBytes: number): ToolExecutionResult {
  const sanitized = sanitizeToolResult(result)
  if (Buffer.byteLength(safeJson(mcpResult(sanitized)), 'utf8') <= maxResponseBytes) return sanitized
  return responseLimitResult()
}

/** Build the one durable result record corresponding to a terminal outcome. */
function externalResultRecord(
  callId: ExternalToolCallId,
  name: string,
  result: ToolExecutionResult,
  turnId?: string,
): ExternalToolResultRecord {
  return result.isError
    ? { ...turnId === undefined ? {} : { turnId }, callId, name, isError: true, error: result.error }
    : { ...turnId === undefined ? {} : { turnId }, callId, name, isError: false, result: result.value }
}

/** Build the complete durable call envelope after applying the gateway policy. */
function externalCallRecord(
  callId: ExternalToolCallId,
  name: string,
  args: unknown,
  turnId?: string,
): ExternalToolCallRecord {
  return {
    ...turnId === undefined ? {} : { turnId },
    callId,
    name,
    arguments: args,
  }
}

/** Keep the recorder's independent durable-call limit fail-closed. */
function fitsExternalCallRecord(record: ExternalToolCallRecord): boolean {
  return Buffer.byteLength(safeJson(record), 'utf8') <= MAX_EXTERNAL_TOOL_RECORD_BYTES
}

/** Keep the recorder's independent durable-event limit fail-closed. */
function fitsExternalResultRecord(record: ExternalToolResultRecord): boolean {
  return Buffer.byteLength(safeJson(record), 'utf8') <= MAX_EXTERNAL_TOOL_RECORD_BYTES
}

const DURABLE_FALLBACK_CALL_ID = ExternalToolCallId('mcp-00000000-0000-0000-0000-000000000000')

/** Reject a tool name that cannot carry the fixed terminal error envelope. */
function fitsDurableFallbackForName(name: string, turnId?: string): boolean {
  return fitsExternalResultRecord(externalResultRecord(
    DURABLE_FALLBACK_CALL_ID,
    name,
    responseLimitResult(),
    turnId,
  ))
}

/** Find the active external turn that the durable recorder will attach. */
function currentExternalTurnId(events: readonly SessionEvent[]): string | undefined {
  let turnId: string | undefined
  for (const event of events) {
    const type = event.type as string
    if (type === 'external/turn-started') {
      const value = (event.data as { readonly turnId?: unknown }).turnId
      turnId = typeof value === 'string' && value.length > 0 ? value : undefined
    } else if (type === 'external/turn-ended') {
      const value = (event.data as { readonly turnId?: unknown }).turnId
      if (typeof value !== 'string' || value === turnId) turnId = undefined
    } else if (type === 'external/session-ended') {
      turnId = undefined
    }
  }
  return turnId
}

/** Return an MCP JSON-RPC request id as a stable call correlation suffix. */
function callIdFor(): string {
  return `mcp-${randomUUID()}`
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
    private readonly maxResponseBytes: number,
    private readonly executionTimeoutMs: number,
    private readonly path: string,
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
    // Authentication is intentionally the first operation: no method,
    // content-type, body, or MCP parser runs for an unauthenticated request.
    if (!validBearer(headerString(req.headers.authorization), this.bearerToken)) {
      sendError(res, 401, 'authorization required')
      return
    }
    if (this.disposed) {
      sendMcpError(res, 404, -32000, 'MCP endpoint is unavailable')
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
        sendGatewayError(res, error)
        return
      }
      sendMcpError(res, 400, -32603, 'MCP request could not be handled')
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
    emitContained(this.ctx, 'mcp-gateway/lease-disposed', {
      route: this.path,
      sessionId: String(this.principal.session.id),
    })
  }

  private async handleAuthenticated(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = headerString(req.headers['mcp-session-id'])
    switch (req.method) {
      case 'POST': {
        requireAccept(req, 'POST')
        requireJsonContentType(req)
        const body = await readJsonBody(req, this.maxRequestBytes, this.executionTimeoutMs, this.controller.signal)
        const messages = parseJsonRpcMessages(body)
        const initialization = messages.some(isInitializeRequest)
        if (!initialization && sessionId === undefined) {
          throw new GatewayRequestError(400, -32000, 'Bad Request: Mcp-Session-Id header is required')
        }
        if (sessionId !== undefined && !this.connections.has(sessionId)) {
          throw new GatewayRequestError(404, -32001, 'Session not found')
        }
        if (!initialization) requireSupportedProtocolVersion(req)
        const connection = sessionId === undefined ? await this.createConnection() : this.connections.get(sessionId)
        if (connection === undefined) throw new GatewayRequestError(404, -32001, 'Session not found')
        if (this.disposed) throw new GatewayRequestError(404, -32000, 'MCP endpoint is unavailable')
        await connection.transport.handleRequest(req, res, body)
        return
      }
      case 'GET': {
        requireAccept(req, 'GET')
        if (sessionId === undefined) throw new GatewayRequestError(400, -32000, 'MCP session id is required')
        const connection = this.connections.get(sessionId)
        if (connection === undefined) throw new GatewayRequestError(404, -32001, 'Session not found')
        requireSupportedProtocolVersion(req)
        await connection.transport.handleRequest(req, res)
        return
      }
      case 'DELETE': {
        if (sessionId === undefined) throw new GatewayRequestError(400, -32000, 'MCP session id is required')
        const connection = this.connections.get(sessionId)
        if (connection === undefined) throw new GatewayRequestError(404, -32001, 'Session not found')
        requireSupportedProtocolVersion(req)
        await connection.transport.handleRequest(req, res)
        return
      }
      default:
        res.setHeader('allow', 'GET, POST, DELETE')
        sendMcpError(res, 405, -32000, 'Method not allowed.')
    }
  }

  private async createConnection(): Promise<McpConnection> {
    if (this.disposed) throw new GatewayRequestError(404, -32000, 'MCP endpoint is unavailable')
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
    if (entry === undefined) throw new Error('MCP tool is unavailable')
    const current = this.ctx.tools.get(name, this.principal)
    if (current !== entry.definition) throw new Error('MCP tool is unavailable')
    const callId = ExternalToolCallId(callIdFor())
    const args = request.params.arguments ?? {}
    const turnId = currentExternalTurnId(this.principal.session.events)
    const durableArguments = sanitizeJsonValue(args, 0, false)
    const callRecord = externalCallRecord(callId, name, durableArguments, turnId)
    const recorder = this.principal.recorder
    if (recorder.recordCall === undefined || recorder.recordResult === undefined) {
      throw new Error('MCP tool recorder is unavailable')
    }
    if (!fitsExternalCallRecord(callRecord) || !fitsDurableFallbackForName(name, turnId)) {
      throw new Error('MCP tool call cannot fit the durable recorder envelope')
    }
    await recorder.recordCall(callRecord)
    const startObserverError = emitContained(this.ctx, 'mcp-gateway/call-started', {
      route: this.path,
      callId: String(callId),
      sessionId: String(this.principal.session.id),
    })
    let result: ToolExecutionResult
    const requestSignalState = requestSignal(extra.signal, this.controller.signal, this.executionTimeoutMs)
    try {
      if (startObserverError !== undefined) {
        result = thrownResult(new Error('MCP gateway observer failed'))
      } else {
        result = await this.ctx.tools.execute({
          callId: CallId(String(callId)),
          name,
          arguments: args,
          principal: this.principal,
          signal: requestSignalState.signal,
        })
      }
    } catch (error: unknown) {
      result = thrownResult(error)
    } finally {
      requestSignalState.dispose()
    }
    let terminal: ToolExecutionResult
    try {
      terminal = boundToolResult(result, this.maxResponseBytes)
    } catch {
      // A malformed tool projection (for example a cyclic runtime value) is
      // still one bounded terminal error, never an unpaired committed call.
      terminal = thrownResult(new Error(RESPONSE_LIMIT_MESSAGE))
    }
    let resultRecord = externalResultRecord(callId, name, terminal, turnId)
    if (!fitsExternalResultRecord(resultRecord)) {
      terminal = responseLimitResult()
      resultRecord = externalResultRecord(callId, name, terminal, turnId)
    }
    let durableResultCommitted = false
    try {
      await recorder.recordResult(resultRecord)
      durableResultCommitted = true
    } catch {
      // A recorder can reject an oversized candidate before committing it.
      // Retry exactly once with a fixed bounded error so every accepted call
      // still has one terminal durable result.
      terminal = responseLimitResult()
      resultRecord = externalResultRecord(callId, name, terminal, turnId)
      try {
        await recorder.recordResult(resultRecord)
        durableResultCommitted = true
      } catch {
        // Session teardown may have closed the recorder after the call was
        // accepted. The external-session finalizer owns that final result.
      }
    }
    if (durableResultCommitted) {
      emitContained(this.ctx, 'mcp-gateway/call-terminal', {
        route: this.path,
        callId: String(callId),
        sessionId: String(this.principal.session.id),
      })
    }
    return mcpResult(terminal)
  }
}

/** A header value narrowed from Node's string/string[] union. */
function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Validate JSON-RPC envelopes before routing by session or protocol version. */
function parseJsonRpcMessages(value: unknown): readonly JSONRPCMessage[] {
  const values = Array.isArray(value) ? value : [value]
  const messages: JSONRPCMessage[] = []
  for (const message of values) {
    const parsed = JSONRPCMessageSchema.safeParse(message)
    if (!parsed.success) throw new GatewayRequestError(400, -32700, 'Parse error: Invalid JSON-RPC message')
    messages.push(parsed.data)
  }
  return messages
}

/** Gateway service/provider registered in the host Cordis composition. */
export class McpGateway extends Service implements McpGatewayService {
  static inject = ['webServer', 'tools']

  static Config: z<Config> = z.object({
    allowlist: z.array(z.string()).default([]),
    maxRequestBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_REQUEST_BYTES),
    maxResponseBytes: z.number().step(1)
      .min(MIN_MAX_RESPONSE_BYTES)
      .max(MAX_EXTERNAL_TOOL_RECORD_BYTES)
      .default(DEFAULT_MAX_RESPONSE_BYTES),
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
      emitContained(this.ctx, 'mcp-gateway/teardown-complete')
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
      if (!fitsDurableFallbackForName(name)) {
        throw new Error('mcp-gateway: selected tool name cannot fit a durable terminal result')
      }
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
      this.config.maxResponseBytes,
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
      emitContained(this.ctx, 'mcp-gateway/lease-created', {
        route: path,
        sessionId: String(request.principal.session.id),
      })
    } catch (error) {
      this.routes.delete(path)
      await lease[Symbol.asyncDispose]().catch(() => {})
      throw error
    }
    return lease
  }
}

export default McpGateway
