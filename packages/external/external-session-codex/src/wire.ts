/**
 * Persistent Codex app-server 0.147.0 wire adapter. The shared newline JSON-RPC
 * transport (`@deepseek-ai/dsh-sdk-protocol`) owns framing and request
 * correlation; this module owns only the product methods and the live-turn
 * notification routing that drive an interactive external session — a
 * non-ephemeral thread, repeated `turn/start` on one thread, streamed deltas,
 * committed-item and terminal-turn notifications, approval asks answered by
 * the caller, cold reattach via `thread/resume`, and native `model/list`.
 *
 * The one-shot sibling (`@deepseek-ai/dsh-subagent-codex`) does not export its
 * wire, and its single-ephemeral-thread, unattended-approval dataflow does not
 * fit interactive sessions, so the shared transport (not a copied adapter) is
 * the reuse boundary; the product methods differ and live here.
 *
 * @module @deepseek-ai/dsh-external-session-codex/wire
 */

import type { Readable, Writable } from 'node:stream'
import type { ExternalModelInfo } from '@deepseek-ai/dsh-external-session'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

/** A JSON object carried by the app-server protocol. */
export type JsonObject = Record<string, unknown>

/** The terminal status values the wire accepts for a turn. */
export type CodexTurnTerminalStatus = 'completed' | 'interrupted' | 'failed'

/** The terminal facts of one turn, as reported by `turn/completed`. */
export interface CodexTurnEnd {
  readonly id: string
  readonly status: CodexTurnTerminalStatus | (string & {})
  /** The turn's `error` object, or null/undefined for a clean terminal. */
  readonly error: unknown
}

/** One approval ask the app-server poses; answered with `{ decision }`. */
export interface CodexApprovalAsk {
  readonly threadId: string
  readonly turnId: string | null
  readonly itemId: string
  readonly reason: string | null
  readonly command: string | null
  /** The raw `availableDecisions` offered by the request, for decision picking. */
  readonly availableDecisions: unknown
}

/** Outward event sinks the persistent session drives off live app-server activity. */
export interface CodexWireHooks {
  /** A turn became the active live turn. */
  onTurnStarted(turnId: string): void
  /** A tool-like item began (item/started). */
  onItemStarted(turnId: string, item: JsonObject): void
  /** An item committed (item/completed): agent messages, user messages, tool results. */
  onCommittedItem(turnId: string, item: JsonObject): void
  /** Live assistant text delta for one turn. */
  onDelta(turnId: string, delta: string): void
  /** The active turn reached a terminal state. */
  onTurnEnded(end: CodexTurnEnd): void
  /** The app-server protocol or stream closed with an error before dispose. */
  onProcessClosed(error: Error): void
  /** Resolve one approval ask with the wire `decision` string to answer. */
  answerApproval(ask: CodexApprovalAsk): Promise<string>
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`external-session-codex: app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`external-session-codex: app-server returned invalid ${label}`)
  }
  return value
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`external-session-codex: app-server request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One interactive app-server connection on a persistent (non-ephemeral) thread.
 * The class deliberately exposes no generic request surface: a new product
 * method becomes part of the provider contract before it is surfaced here.
 */
export class CodexExternalWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private threadId: string | undefined
  private pendingTurnId: string | undefined
  private currentTurnId: string | undefined
  private turnActive = false
  private readonly earlyTurnNotifications: Array<{
    readonly method: string
    readonly params: JsonObject
  }> = []
  private closed = false

  constructor(
    input: Readable,
    output: Writable,
    private readonly hooks: CodexWireHooks,
  ) {
    this.transport = new JsonRpcLineTransport(input, output)
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleServerRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.fail(thrown(error))
      }
    })
    input.on('error', this.onInputError)
    input.on('end', this.onInputEnd)
    output.on('error', this.onOutputError)
  }

  /** Start reading app-server frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Perform the required initialize/initialized handshake.
   * @param signal - operation cancellation.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }, signal), signal), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
  }

  /**
   * Create the session's persistent thread. Evidence line: `thread/start`
   * with `ephemeral: false` persists to a rollout `.jsonl`
   * (tests/evidence/README.md, thread-persistence.json).
   * @param cwd - the session workspace.
   * @param signal - operation cancellation.
   * @returns the new thread id.
   */
  async startPersistentThread(cwd: string, signal: AbortSignal): Promise<string> {
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd,
      ephemeral: false,
    }, signal), signal), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    return this.commitThreadId(string(thread.id, 'thread/start thread id'))
  }

  /**
   * Reattach a persisted thread after an app-server restart. Evidence line:
   * `thread/resume { threadId }` resumes a persisted thread on a cold process
   * (tests/evidence/README.md, thread-persistence.json).
   * @param threadId - the persisted thread to resume.
   * @param signal - operation cancellation.
   * @returns the resumed thread id.
   */
  async resumeThread(threadId: string, signal: AbortSignal): Promise<string> {
    await this.guarded(this.transport.request('thread/resume', { threadId }, signal), signal)
    return this.commitThreadId(threadId)
  }

  /**
   * Start one turn on the active thread and return its id. The turn then runs
   * to completion asynchronously: live deltas and committed items stream out
   * through the hooks until `turn/completed`.
   * @param text - the validated user prompt text.
   * @param signal - operation cancellation.
   * @returns the provider-issued turn id.
   */
  async startTurn(text: string, signal: AbortSignal): Promise<string> {
    const threadId = this.threadId as string
    this.turnActive = true
    const response = object(await this.guarded(this.transport.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    }, signal), signal), 'turn/start response')
    const turn = object(response.turn, 'turn/start turn')
    return this.commitTurnId(string(turn.id, 'turn/start turn id'))
  }

  /**
   * List the models this native install can switch to. Evidence line:
   * `model/list` exists natively and returns `{ data, nextCursor }`
   * (tests/evidence/README.md, models.json) — no fallback roster required.
   * @param signal - operation cancellation.
   * @returns the disclosed models.
   */
  async listModels(signal: AbortSignal): Promise<ExternalModelInfo[]> {
    const response = object(await this.guarded(this.transport.request('model/list', {}, signal), signal), 'model/list response')
    const data = response.data
    if (!Array.isArray(data)) {
      throw new Error('external-session-codex: app-server returned invalid model/list data')
    }
    const models: ExternalModelInfo[] = []
    for (const entry of data) {
      const model = object(entry, 'model/list entry')
      const id = string(model.id, 'model/list id')
      const name = string(model.displayName ?? model.model, 'model/list name')
      const described: ExternalModelInfo = typeof model.description === 'string'
        ? { id, name, description: model.description }
        : { id, name }
      models.push(described)
    }
    return models
  }

  /**
   * Start the dedicated compact path. Evidence line: `thread/compact/start`
   * is the compact method and responds `{}` immediately with compaction
   * running as a background turn (tests/evidence/README.md, compact.json).
   * @param signal - operation cancellation.
   */
  async compact(signal: AbortSignal): Promise<void> {
    await this.guarded(this.transport.request('thread/compact/start', {
      threadId: this.threadId as string,
    }, signal), signal)
  }

  /**
   * Best-effort interruption of the active turn. Local settlement and process
   * teardown remain authoritative when the child no longer accepts requests.
   */
  interrupt(): void {
    if (this.threadId === undefined || this.currentTurnId === undefined || this.closed) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.currentTurnId,
    }).catch(() => {})
  }

  /** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return raceAbort(Promise.race([this.fatal.promise, pending]), signal)
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
    this.hooks.onProcessClosed(error)
  }

  private readonly onInputError = (error: Error): void => {
    /* v8 ignore next -- handled by fail(); kept as a named listener to detach. */
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    /* v8 ignore next -- handled by fail(); kept as a named listener to detach. */
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.fail(new Error('external-session-codex: app-server protocol stream closed'))
  }

  private commitThreadId(id: string): string {
    this.threadId = id
    return id
  }

  private observePendingTurnId(id: string): void {
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('external-session-codex: app-server referenced conflicting turns')
    }
    this.pendingTurnId = id
  }

  private commitTurnId(id: string): string {
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('external-session-codex: turn/start response did not match the active turn')
    }
    this.currentTurnId = id
    this.hooks.onTurnStarted(id)
    const notifications = this.earlyTurnNotifications.splice(0)
    for (const notification of notifications) {
      this.handleNotification(notification.method, notification.params)
    }
    return id
  }

  private async handleServerRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          this.validateRunIds(params)
          return { decision: await this.currentApprovalDecision(params) }
        case 'item/permissions/requestApproval':
          this.validateRunIds(params)
          return { permissions: {}, scope: 'turn' }
        case 'item/tool/requestUserInput':
          this.validateRunIds(params)
          return { answers: {} }
        case 'mcpServer/elicitation/request':
          this.validateRunIds(params, true)
          return { action: 'decline', content: null, _meta: null }
        default:
          throw new Error(`external-session-codex: unsupported app-server request ${JSON.stringify(method)}`)
      }
    } catch (error: unknown) {
      const normalized = thrown(error)
      this.fail(normalized)
      return Promise.reject(normalized)
    }
  }

  /** Build and answer one approval ask through the caller's hook. */
  private currentApprovalDecision(params: JsonObject): Promise<string> {
    const itemId = typeof params.itemId === 'string' ? params.itemId : ''
    const ask: CodexApprovalAsk = {
      threadId: this.threadId as string,
      turnId: typeof params.turnId === 'string' ? params.turnId : null,
      itemId,
      reason: typeof params.reason === 'string' ? params.reason : null,
      command: typeof params.command === 'string' ? params.command : null,
      availableDecisions: params.availableDecisions,
    }
    return this.hooks.answerApproval(ask)
  }

  private validateRunIds(params: JsonObject, nullableTurn = false): void {
    if (params.threadId !== this.threadId) {
      throw new Error('external-session-codex: app-server request referenced another thread')
    }
    if (nullableTurn && params.turnId === null) return
    const id = string(params.turnId, 'external-session-codex server request turn id')
    if (this.currentTurnId === undefined) {
      this.observePendingTurnId(id)
      return
    }
    if (id !== this.currentTurnId) {
      throw new Error('external-session-codex: app-server request referenced another turn')
    }
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === 'turn/started') {
      const threadId = string(params.threadId, 'turn/started thread id')
      if (threadId !== this.threadId) return
      const turn = object(params.turn, 'turn/started turn')
      if (this.turnActive && this.currentTurnId === undefined) {
        this.earlyTurnNotifications.push({ method, params })
        this.observePendingTurnId(string(turn.id, 'turn/started turn id'))
      }
      return
    }
    if (method === 'item/started') {
      if (this.requireActiveTurn(method, params)) {
        this.hooks.onItemStarted(
          params.turnId as string,
          object(params.item, 'item/started item'),
        )
      }
      return
    }
    if (method === 'item/agentMessage/delta') {
      if (this.requireActiveTurn(method, params)) {
        this.hooks.onDelta(params.turnId as string, string(params.delta, 'item/agentMessage/delta'))
      }
      return
    }
    if (method === 'item/completed') {
      if (this.requireActiveTurn(method, params)) {
        this.hooks.onCommittedItem(params.turnId as string, object(params.item, 'item/completed item'))
      }
      return
    }
    if (method !== 'turn/completed') return
    const threadId = string(params.threadId, 'turn/completed thread id')
    if (threadId !== this.threadId) return
    const turn = object(params.turn, 'turn/completed turn')
    const id = string(turn.id, 'turn/completed turn id')
    if (this.currentTurnId === undefined) {
      this.observePendingTurnId(id)
      this.earlyTurnNotifications.push({ method, params })
      return
    }
    if (id !== this.currentTurnId) return
    this.currentTurnId = undefined
    this.turnActive = false
    this.hooks.onTurnEnded({ id, status: String(turn.status), error: turn.error })
  }

  /**
   * Validate an item notification against the active turn, queueing it for
   * replay when the turn id is not yet known from `turn/start`.
   * @returns whether the item belongs to the committed active turn.
   */
  private requireActiveTurn(method: string, params: JsonObject): boolean {
    if (!this.turnActive) return false
    if (params.threadId !== this.threadId) return false
    const id = string(params.turnId, 'external-session-codex item turn id')
    if (this.currentTurnId === undefined) {
      this.observePendingTurnId(id)
      this.earlyTurnNotifications.push({ method, params })
      return false
    }
    return id === this.currentTurnId
  }
}

/** Map a `turn/completed` status and error onto the external stop reason. */
export function mapExternalStopReason(
  status: CodexTurnTerminalStatus | (string & {}),
  error: unknown,
): 'completed' | 'aborted' | 'error' | 'max-tokens' {
  if (status === 'completed') return 'completed'
  if (status === 'interrupted') return 'aborted'
  if (status === 'failed') {
    // Evidence line: a failed turn whose `codexErrorInfo` is
    // `contextWindowExceeded` maps to max-tokens
    // (tests/evidence/README.md; subagent-codex wire reference).
    if (error !== null && typeof error === 'object' && !Array.isArray(error)
      && (error as JsonObject).codexErrorInfo === 'contextWindowExceeded') {
      return 'max-tokens'
    }
    return 'error'
  }
  throw new Error(`external-session-codex: app-server returned invalid terminal turn status ${JSON.stringify(status)}`)
}

/** Pick an approval decision: the requested one when offered, else the safe `decline`. */
export function offeredApprovalDecision(
  available: unknown,
  fallback: 'accept' | 'decline' | 'cancel',
): 'accept' | 'decline' | 'cancel' {
  if (!Array.isArray(available)) return fallback
  const offered = new Set<string>()
  for (const entry of available) {
    if (typeof entry === 'string') offered.add(entry)
    else if (entry !== null && typeof entry === 'object') {
      for (const key of Object.keys(entry as JsonObject)) offered.add(key)
    }
  }
  if (offered.has(fallback)) return fallback
  // Evidence: the decline arm answers `{ decision: "decline" }` even when
  // `availableDecisions` omits plain `decline` (approvals.json) — it is the
  // universal safe non-approval decision for this app-server.
  return 'decline'
}
