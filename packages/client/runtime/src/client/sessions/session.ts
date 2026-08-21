// Sessions remain resident after creation so they continue consuming mux frames off-screen.

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  HistoryEntry, IApiClient, MessageId, MuxFrame, PromptContentPart, QueueAction, RpcError,
  RpcId, RpcResponse, RpcResult, SessionId, SubagentAddress, ToolEventView,
} from '@deepseek-ai/dsh-api-remotes/client'
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionFace } from '../contract/session.ts'
import { ConversationNodeAssembler } from './conversation-assembler.ts'
import type { ConversationRuntime } from './conversation-assembler.ts'
import type { ConversationEventInput, ConversationPublication } from '../contract/conversation.ts'
import type {
  ChatSnapshot, ComposerPhase, ConversationSnapshot, OpenState, PromptError,
} from './conversation.ts'
import { EMPTY_CHAT_SNAPSHOT } from './conversation.ts'
import type { PendingInteraction } from './pending.ts'
import { PendingWait } from './pending.ts'
import { Notifier } from './notifier.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRemotes } from './remotes.ts'
import { ProjectionValueStore } from './projection-store.ts'
import type { ProjectionsBaseline } from './projection-store.ts'
import { resolvedClientTimeZone } from '../time-zone.ts'
import { SessionQueueMirror } from './queue-mirror.ts'
import { ExternalLiveAccumulator } from './external-live.ts'

/** One external command waiting for the next durable provider turn terminal. */
interface ExternalTurnWaiter {
  minimumSeq: number
  armed: boolean
  expectedTurnId: string | undefined
  readonly promise: Promise<void>
  arm(turnId: string | undefined): void
  settle(): void
  fail(error: unknown): void
  cancel(): void
}

/** Messages requested per history page. */
export const PAGE_MESSAGES = 50

/** Manager-owned observers of a Session object's local state edges. */
export interface SessionOptions {
  /** Durable driver mode from the host summary; `dsh`/absent uses native remotes. */
  mode?: string
  /** Catalog-discovered address selecting non-activating subagent transport. */
  address?: SubagentAddress
  /** Whether the exact direct parent Agent was live at the latest catalog read. */
  parentAvailable?: boolean
  /**
   * First ACCEPTED prompt on a blank session (fires at most once, on the
   * prompt RPC's success response): the manager mirrors the blank→false flip
   * into its list row so the session surfaces without waiting for a host
   * frame. Acceptance is the flip point because it proves the user message
   * is in the host log; a rejected first prompt keeps the session blank
   * (hidden, still reusable by connectWorkspace).
   */
  onEngaged?(session: Session): void
  /**
   * Manager-owned projection value store to adopt (frames route through the
   * manager and values outlive instantiation); omitted, the Session owns a
   * private store (bare object-layer construction).
   */
  projections?: ProjectionValueStore
  /** Runtime registries used by this Session-owned Conversation assembler. */
  conversation?: ConversationRuntime
}

/**
 * Owns a session's event window, derived conversation state, and observable
 * snapshot. React bindings remain outside this data layer. Features see only
 * the {@link SessionFace} slice (ISession verbs + the snapshot source); the
 * remaining public members are manager/runtime entry points.
 */
export class Session implements SessionFace {
  // ---- Window and derived state (all private; the snapshot is the only read API) ----
  private events: SessionEvent[] = []
  /** Wire views aligned with `events` by index (envelope-level annotations; undefined = no view).
   *  Kept parallel rather than merged so `events` stays the raw log slice (model-visible ⟺ logged). */
  private views: (ToolEventView | undefined)[] = []
  private baseSeq = 0
  private hasMore = false
  private openState: OpenState = 'cold'
  private openError: RpcError | null = null
  private openPromise: Promise<void> | null = null
  /** Bumped by resync to invalidate an in-flight doOpen: a reconnect must rebuild, never adopt
   *  a pre-disconnect open whose history request is already doomed. Stale doOpen
   *  passes drop all writes once the generation moves on. */
  private openGeneration = 0
  private loadingOlder = false
  private pending = new Map<string, PendingInteraction>()
  private pendingRev = 0
  private pendingCache: { rev: number; value: PendingInteraction[] } | null = null
  /** Authoritative stream-only inbox snapshot; pending work never hits history. */
  private readonly queueMirror = new SessionQueueMirror()
  /** Transient external-agent output; reset at every connection/subscription generation. */
  private readonly externalLive = new ExternalLiveAccumulator()
  /** External deltas received while the history window is opening or repairing. */
  private externalDeltaBuffer: { turnId: string; delta: string }[] = []
  /** Session-owned business Context engine over the contiguous raw window. */
  private readonly conversation: ConversationNodeAssembler
  private running = false
  private address: SubagentAddress | undefined
  private parentAvailable = false
  private sessionMode: string | undefined
  private readonly externalTurnWaiters: ExternalTurnWaiter[] = []
  /** Highest terminal event already observed; protects a loading-buffer replay from settling twice. */
  private lastObservedExternalTerminalSeq = -1
  /** Recent terminal identities allow a provider response to arm after its terminal notification. */
  private readonly recentExternalTerminals = new Map<string, number>()
  /**
   * Sticky send marker, private input of the composerPhase derivation: set
   * synchronously before prompt()'s first await, never reset — the blank →
   * engaging edge of the phase machine (see ComposerPhase).
   */
  private promptAttempted = false
  /** A first accepted prompt stays in the engaging phase until its turn is observable. */
  private firstPromptPendingTurn = false
  /** Empty-log mirror (see ConversationSnapshot.blank); unknown bare sessions begin conservatively blank. */
  private blankBit = true
  private removed = false
  private promptError: PromptError | null = null
  private lastAgentError: string | null = null
  /** Live events buffered during open/resync and stitched by sequence once history lands. */
  private liveBuffer: { event: SessionEvent; view: ToolEventView | undefined }[] = []
  /** Gap repair in flight; live events detour to the buffer until the tail page lands. */
  private stitching = false
  /** subscribed.lastSeq baseline (gap detection; null when no subscribed frame arrived — degrade to the liveBuffer dedup path). */
  private subscribedLastSeq: number | null = null

  /**
   * Per-session projection value store (push model; see the session-projection
   * subsystem page, docs/subsystems/session-projection.md): finished whole
   * values computed on the host, seeded by the tail page's
   * projections block and updated by `session/projection` frames under the
   * one higher-seq-wins rule. Keys are read via `projections.faceOf(key)`
   * (the useProjection resolution face); the conversation snapshot never
   * carries projection values, and no client-side domain folding exists.
   * Manager-owned when constructed through SessionManager (frames route and
   * the store outlives instantiation, the title-snapshot precedent); a bare
   * construction gets a private store.
   */
  readonly projections: ProjectionValueStore

  private snapshotCache: ConversationSnapshot
  private readonly notifier: Notifier
  /**
   * Agent-scoped cordis context, bound once by SessionRuntime when it
   * mints the scope (the client mirror of the host Agent's loopCtx). The
   * Session dispatches its own scoped events through it; undefined means
   * unbound (bare object-layer construction) or already pruned — both skip
   * dispatch-dependent behavior rather than fail.
   */
  private actx: Context | undefined

  /**
   * @param sessionId - Host session identity (client sessions are always Host-born).
   * @param api - shared wire client.
   * @param remote - generated Remote namespaces this session calls.
   * @param options - optional manager-owned state observers.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly api: IApiClient,
    private readonly remote: SessionRemotes,
    private readonly options: SessionOptions = {},
  ) {
    this.projections = options.projections ?? new ProjectionValueStore()
    this.sessionMode = options.mode
    this.address = options.address
    this.parentAvailable = options.parentAvailable ?? false
    this.conversation = options.conversation === undefined
      ? new ConversationNodeAssembler(
        { entries: () => [], fallbackEntry: () => undefined },
        { entries: () => [] },
      )
      : new ConversationNodeAssembler(options.conversation.events, options.conversation.views)
    this.notifier = new Notifier(() => {
      this.conversation.flush()
      this.snapshotCache = this.buildSnapshot()
    })
    this.snapshotCache = this.buildSnapshot()
  }

  /** Durable driver mode used by client routing and mode-aware presentations. */
  get mode(): string | undefined {
    return this.sessionMode
  }

  /**
   * Bind the Agent-scoped context minted by SessionRuntime (single write;
   * a second bind is a wiring error and throws). Direction stays one-way at
   * this binding boundary: consumers still reach the Session via `sessions.sessionOf`,
   * while the Session holds its own dispatch point (host Agent.loopCtx
   * mirror).
   * @param actx - the agent's scoped context.
   */
  bindScope(actx: Context): void {
    if (this.actx !== undefined) throw new Error(`session ${this.sessionId} already has a bound scope`)
    this.actx = actx
  }

  /** Release the bound scope at prune time (a later rebind accompanies a freshly minted scope). */
  unbindScope(): void {
    this.actx = undefined
  }

  // ---- Operations ----

  /**
   * Send through the native Agent or, for an external mode, forward text through
   * `session.command`; failures land in the snapshot's promptError.
   * @param content - text plus browser-owned temporary image uploads.
   * @param mode - native queue appends after the current turn; native steer interrupts it.
   * @returns the prompt result (also mirrored into promptError on failure).
   */
  async prompt(content: PromptContentPart[], mode: 'queue' | 'steer'): Promise<RpcResult<{ accepted: true }>> {
    this.promptError = null
    this.lastAgentError = null
    // Synchronous, before the first await: the blank → engaging edge must be
    // visible on the session area's very first frame when a caller sends
    // ahead of navigation (first-send flow).
    this.promptAttempted = true
    if (this.blankBit) this.firstPromptPendingTurn = true
    this.notifier.markDirty()
    let result: RpcResult<{ accepted: true }>
    try {
      if (this.isExternalMode()) {
        if (content.some(part => part.type === 'image')) {
          result = {
            ok: false,
            error: {
              code: 'external-images-unsupported',
              message: 'External sessions do not accept image input yet.',
              details: { mode: this.sessionMode ?? 'external' },
            },
          }
        } else if (mode === 'steer') {
          result = {
            ok: false,
            error: {
              code: 'external-steer-unsupported',
              message: 'External sessions do not support steering yet.',
              details: { mode: this.sessionMode ?? 'external' },
            },
          }
        } else {
          const command = await this.command(content.flatMap(part => part.type === 'text' ? [part.text] : []).join(''))
          result = command.ok
            ? { ok: true, value: { accepted: true } }
            : { ok: false, error: command.error as RpcError }
        }
      } else if (this.address === undefined) {
        result = (await this.api.sessions.prompt({
          sessionId: this.sessionId,
          mode,
          content,
          clientTimeZone: resolvedClientTimeZone(),
        })).result
      } else if (this.address.mode === 'one-shot') {
        result = {
          ok: false,
          error: {
            code: 'subagent-not-resumable',
            message: 'one-shot subagent conversations are read-only',
            details: { childSessionId: this.address.childSessionId },
          },
        }
      } else {
        if (content.some(part => part.type === 'image')) {
          result = {
            ok: false,
            error: {
              code: 'attachment-error',
              message: 'Image input is unavailable for subagent continuations.',
              details: { reason: 'SUBAGENT_IMAGE_UNSUPPORTED' },
            },
          }
        } else {
          const routed = (await this.api.subagents.prompt({
            ...this.address,
            content: content.flatMap(part => part.type === 'text'
              ? [{ type: 'text' as const, text: part.text }]
              : []),
            clientTimeZone: resolvedClientTimeZone(),
          })).result
          result = routed.ok ? { ok: true, value: { accepted: true } } : routed
        }
      }
    } catch (error) {
      result = transportError(error)
    }
    if (!result.ok) {
      this.promptError = { op: 'send', error: result.error }
      this.notifier.markDirty()
      return result
    }
    // Blank flips on ACCEPTANCE, not attempt: an accepted prompt starts the
    // conversation's first turn on the host (the host criterion — a logged
    // turn/start — is fact, not optimism; standalone command and projection
    // events never flip it), while a rejected first prompt must keep the
    // session blank — the client-side blank mirror only ever lowers, so
    // flipping early on a failure would surface the session forever and
    // strip its connectWorkspace reuse eligibility against the host's
    // authority.
    if (this.blankBit) {
      this.blankBit = false
      this.options.onEngaged?.(this)
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * Resolve one image referenced by this session into browser-consumable bytes.
   * @param attachmentId - opaque id found in the folded session log.
   * @returns the authenticated reference and decoded bytes.
   */
  async readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RpcResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>> {
    try {
      const result = (await this.api.sessions.attachment({
        sessionId: this.sessionId,
        attachmentId,
      })).result
      if (!result.ok) return result
      const binary = atob(result.value.data)
      const data = Uint8Array.from(binary, char => char.charCodeAt(0))
      return { ok: true, value: { attachment: result.value.attachment, data } }
    } catch (error) {
      return transportError(error)
    }
  }

  /** Apply one operation to a still-pending queue occurrence. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<RpcResult<{ accepted: true }>> {
    if (this.isExternalMode()) {
      return {
        ok: false,
        error: {
          code: 'external-queue-unsupported',
          message: 'External sessions do not expose queued-message operations yet.',
          details: { itemId, action: action.kind },
        },
      }
    }
    try {
      return (await this.api.sessions.updateQueue({ sessionId: this.sessionId, itemId, action })).result
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Stop the active turn while the Host preserves pending inbox work; failures
   * land in promptError (same error-strip display slot). A continuable
   * subagent address routes through `subagent.interrupt`, whose durable
   * parent-address authority works without a live parent Agent; a one-shot
   * address stays uncancellable (the UI offers no stop action, so this arm is
   * defensive).
   * @returns the cancel result.
   */
  async cancel(): Promise<RpcResult<{ accepted: true }>> {
    const address = this.address
    if (address !== undefined && address.mode === 'one-shot') {
      const result: RpcResult<{ accepted: true }> = {
        ok: false,
        error: {
          code: 'subagent-delivery-unavailable',
          message: 'subagent activation cancellation is unavailable',
          details: { childSessionId: address.childSessionId },
        },
      }
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
      return result
    }
    let result: RpcResult<{ accepted: true }>
    try {
      result = address !== undefined
        ? (await this.api.subagents.interrupt(address)).result
        : (await this.api.sessions.cancel({ sessionId: this.sessionId })).result
    } catch (error) {
      result = transportError(error)
    }
    if (!result.ok) {
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * Rename: contract session.rename 1:1. On success settle the 'title'
   * projection cell from the response's `{title, seq}` under the store's
   * higher-seq-wins rule (the push frame arriving later is a no-op replay),
   * so the list row and any useProjection('title') reader update without
   * waiting for the mux frame.
   * @param title - raw title text (the host normalizes acceptance).
   * @returns the rename result (normalized accepted title + title event seq).
   */
  async rename(title: string): Promise<RpcResult<{ title: string; seq: number }>> {
    try {
      const { result } = await this.api.sessions.rename({ sessionId: this.sessionId, title })
      if (result.ok) this.projections.apply('title', result.value.title, result.value.seq)
      return result
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Execute one command line. Native sessions use the command registry; external
   * sessions forward plain and provider-specific lines through `session.command`
   * and wait for the durable external turn terminal when a turn is started.
   * @param line - the full command line, leading slash included.
   * @returns the admission result, or the error branch on transport failure.
   */
  async command(line: string): Promise<RemoteResult<{ matched: boolean }>> {
    if (this.isExternalMode()) {
      const commandName = /^\/([a-z0-9_-]+)/iu.exec(line.trim())?.[1]?.toLowerCase()
      if (commandName === 'goal' || commandName === 'goals' || commandName === 'plan') {
        return {
          ok: false,
          error: {
            code: 'external-goals-unsupported',
            message: 'Native goals are unavailable for external sessions.',
            details: { command: commandName },
          },
        }
      }
      const waitsForTurn = commandName !== 'compact' && commandName !== 'model'
      // Register before the RPC for every open state. External providers may
      // emit the terminal event while a cold session is being attached or its
      // history window is loading.
      const wait = waitsForTurn ? this.waitForExternalTurnEnd() : undefined
      try {
        const response = (await this.api.sessions.command({ sessionId: this.sessionId, line })).result
        if (!response.ok) {
          wait?.cancel()
          return response
        }
        if (response.value.kind === 'error') {
          wait?.cancel()
          return {
            ok: false,
            error: {
              code: 'external-command-failed',
              message: response.value.text,
              details: { sessionId: this.sessionId, line },
            },
          }
        }
        if (wait !== undefined) {
          wait.arm(response.value.externalTurnId)
          await wait.promise
        }
        return { ok: true, value: { matched: true } }
      } catch (error: unknown) {
        wait?.cancel()
        return transportError(error)
      }
    }
    const result = await this.remote.commands.execute(this.sessionId, line)
    if (!result.ok) return result
    return { ok: true, value: { matched: result.value !== undefined } }
  }

  /** First open: pull the tail page (idempotent — in-flight/already-open returns the existing promise). */
  open(): Promise<void> {
    if (this.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise
    const promise = this.doOpen(this.openGeneration).finally(() => {
      // Identity-guarded: a superseded open must not null out the promise resync just started.
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  /** Page up: pull one earlier page with the window's first seq as beforeSeq and prepend. */
  async loadOlder(): Promise<void> {
    if (this.openState !== 'open' || !this.hasMore || this.loadingOlder) return
    this.loadingOlder = true
    this.notifier.markDirty()
    try {
      const { result } = await this.history({ beforeSeq: this.baseSeq, maxMessages: PAGE_MESSAGES })
      if (!result.ok) return // keep the window as-is; do not overwrite openError (open already succeeded)
      const older = result.value.events
      if (older.length === 0) {
        this.hasMore = result.value.hasMore
        this.conversation.prepend([], this.hasMore)
        return
      }
      const tail = older[older.length - 1]
      if (tail === undefined || tail.event.seq + 1 !== this.baseSeq) {
        // Continuity assertion: on violation drop the page fail-soft rather than render an out-of-order stream.
        console.error(`[web-runtime] history page discontinuous: tail seq ${tail?.event.seq} vs baseSeq ${this.baseSeq}`)
        this.hasMore = false
        this.conversation.prepend([], false)
        return
      }
      this.events = [...older.map(e => e.event), ...this.events]
      this.views = [...older.map(e => e.view), ...this.views]
      /* v8 ignore next -- the ?? arm needs older[0] undefined, but the empty-page branch above already returned. */
      this.baseSeq = older[0]?.event.seq ?? this.baseSeq
      this.hasMore = result.value.hasMore
      this.conversation.prepend(older.map(conversationInput), this.hasMore)
    } catch (error) {
      console.error('[web-runtime] loadOlder failed:', error)
    } finally {
      this.loadingOlder = false
      this.notifier.markDirty()
    }
  }

  /** Reconnect rebuild (manager calls this on onConnected for instances that were opened):
   *  reset the window and rerun open; pending waits for the baseline replay. Invalidates any
   *  in-flight open first — its history request rode the dead connection and must not settle
   *  the fresh generation into 'error'. */
  async resync(): Promise<void> {
    // The queue mirror is NOT cleared here: onConnected (which drives resync)
    // races the mux frames — the fresh generation's baseline may have landed
    // already, and the host never resends it. The mirror re-baselines on the
    // session/subscribed frame instead (same stream as the queue snapshot
    // that follows it, so ordering is guaranteed).
    this.resetExternalLive()
    if (this.openState === 'cold') return // never opened: no window to rebuild (doOpen flips to 'loading' synchronously, so cold implies no in-flight open)
    this.openGeneration++
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    this.events = []
    this.views = []
    this.baseSeq = 0
    // Superseded, not settled: the baseline replay re-sends still-pending requested frames verbatim
    // (same rpcId), re-minting fresh waits; a stale reference's respond() still reaches the host.
    this.pending.clear()
    this.pendingRev++
    this.subscribedLastSeq = null
    this.liveBuffer = []
    this.notifier.markDirty()
    await this.open()
  }

  // ---- Subscription API (useSyncExternalStore direct wiring) ----

  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached conversation snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getSnapshot(): ConversationSnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  // ---- Manager-only entry points (@internal; never called by the UI) ----

  /**
   * Mux frame arrival (the dispatch switch).
   * @param rpcId - the frame envelope id (the respond backfill key for requested frames).
   * @param frame - the routed frame.
   */
  handleMuxEnvelope(rpcId: RpcId, frame: MuxFrame): void {
    switch (frame.type) {
      case 'session/event': {
        this.acceptLiveEvent(frame.event, frame.view)
        return
      }
      case 'external/delta': {
        this.acceptExternalDelta(frame.turnId, frame.delta)
        return
      }
      case 'session/queue': {
        this.queueMirror.replace(frame.items)
        this.notifier.markDirty()
        return
      }
      case 'session/subscribed': {
        this.subscribedLastSeq = frame.lastSeq
        this.resetExternalLive()
        // New mux-generation baseline: the host pushes this session's queue
        // snapshot AFTER the subscribed frame on the same stream, so the
        // stale mirror clears here — race-free against onConnected/resync
        // timing (clearing there could wipe a baseline that already landed).
        if (this.queueMirror.reset()) this.notifier.markDirty()
        return
      }
      case 'approval/requested': {
        const { type: _type, sessionId: _sid, ...payload } = frame
        this.mint(new PendingWait('approval', rpcId, this.sessionId, payload, m => this.api.respond(m)))
        this.notifier.markDirty()
        return
      }
      case 'approval/resolved': {
        for (const item of this.pending.values()) {
          if (item.kind === 'approval' && item.payload.approvalId === frame.approvalId) this.settle(item)
        }
        this.notifier.markDirty()
        return
      }
      case 'question/requested': {
        const { type: _type, sessionId: _sid, ...payload } = frame
        this.mint(new PendingWait('question', rpcId, this.sessionId, payload, m => this.api.respond(m)))
        this.notifier.markDirty()
        return
      }
      case 'question/resolved': {
        const item = this.pending.get(`q:${frame.questionRpcId}`)
        if (item !== undefined) this.settle(item)
        this.notifier.markDirty()
        return
      }
      default:
        return // stream/error never reaches Session (Controller converges it); unknown frames ignored (documented default)
    }
  }

  /**
   * Running-bit relay from the host stream (list entry and snapshot stay consistent).
   * @param running - the new running state.
   */
  handleRunning(running: boolean): void {
    // Turn-start conversion: a blank session never runs, so the first
    // running:true proves another side's first message landed.
    if (running && this.blankBit) {
      this.blankBit = false
      this.notifier.markDirty()
    }
    if (running) this.firstPromptPendingTurn = false
    if (this.running === running) return
    this.running = running
    this.notifier.markDirty()
  }

  /**
   * Install or clear the catalog-discovered transport address. A changed
   * address rebuilds an already-open window through its new history route.
   * @param address - direct parent/child address, or undefined for ordinary transport.
   * @param parentAvailable - latest exact-parent availability hint.
   */
  configureSubagent(address: SubagentAddress | undefined, parentAvailable = false): void {
    const same = this.address?.parentSessionId === address?.parentSessionId
      && this.address?.childSessionId === address?.childSessionId
      && this.address?.mode === address?.mode
    this.address = address
    this.parentAvailable = parentAvailable
    if (!same && this.openState !== 'cold') void this.resync()
    else this.notifier.markDirty()
  }

  /**
   * Update the durable driver mode from a refreshed list summary.
   * @param mode - current mode from the host summary, or undefined for native sessions.
   */
  configureMode(mode: string | undefined): void {
    if (this.sessionMode === mode) return
    this.sessionMode = mode
    this.notifier.markDirty()
  }

  /**
   * Update only the parent availability hint from a catalog refresh.
   * @param available - whether the exact direct parent is live.
   */
  handleSubagentParentAvailable(available: boolean): void {
    if (this.parentAvailable === available) return
    this.parentAvailable = available
    this.notifier.markDirty()
  }

  /**
   * Blank-bit relay from the authoritative summary source (list baseline and
   * the session-added frame). Monotone: once any signal (local first send,
   * running flip, an earlier summary) cleared it, a stale true never
   * re-blanks.
   * @param blank - the summary's derived empty-log bit.
   */
  handleBlank(blank: boolean): void {
    if (blank === this.blankBit) return
    if (blank && (this.promptAttempted || this.running)) return
    this.blankBit = blank
    this.notifier.markDirty()
  }

  /** host/session-removed relay: flag the snapshot (instance survives — resident-instance rule). */
  handleRemoved(): void {
    this.removed = true
    this.failExternalTurnWaiters(new Error(`session ${this.sessionId} was removed`))
    this.resetExternalLive()
    this.notifier.markDirty()
  }

  /**
   * host/agent-error relay: the only outlet for live failures with no turn position.
   * @param message - the stringified error.
   */
  handleAgentError(message: string): void {
    this.lastAgentError = message
    this.failExternalTurnWaiters(new Error(message))
    this.resetExternalLive()
    this.notifier.markDirty()
  }

  /** Clear transient external output after the connection or session dies. */
  clearExternalLive(): void {
    this.resetExternalLive()
  }

  /** Release command barriers when scope pruning disposes a resident instance. */
  dispose(): void {
    this.failExternalTurnWaiters(new Error(`session ${this.sessionId} was disposed`))
  }

  /** Rebuild the current window after a low-frequency Definition or view registration change. */
  rebuildConversationRegistry(): void {
    this.scheduleConversation(this.conversation.rebuildRegistry())
  }

  // ---- Private ----

  /** Requested-frame arrival: the wait enters the pending map under its own key. */
  private mint(wait: PendingInteraction): void {
    this.pending.set(wait.key, wait)
    this.pendingRev++
  }

  /** Authoritative resolved-frame settlement: mark, then drop from the pending map. */
  private settle(wait: PendingInteraction): void {
    wait.markSettled()
    this.pending.delete(wait.key)
    this.pendingRev++
  }

  /** @param generation - openGeneration at launch; every await re-checks it and a stale pass
   *  drops all writes (resync superseded this open — its outcome belongs to a dead connection). */
  private async doOpen(generation: number): Promise<void> {
    this.openState = 'loading'
    this.openError = null
    this.notifier.markDirty()
    try {
      let { result } = await this.history({ maxMessages: PAGE_MESSAGES })
      if (generation !== this.openGeneration) return
      if (!result.ok) {
        this.openState = 'error'
        this.openError = result.error
        this.externalDeltaBuffer = []
        return
      }
      this.installWindow(result.value.events, result.value.hasMore, result.value.projections)
      // Gap detection: baseline past the window tail and liveBuffer did not cover it -> pull the tail page once more.
      const tailSeq = this.windowTailSeq()
      if (this.subscribedLastSeq !== null && tailSeq !== null && this.subscribedLastSeq > tailSeq) {
        result = (await this.history({ maxMessages: PAGE_MESSAGES })).result
        if (generation !== this.openGeneration) return
        if (result.ok) this.installWindow(result.value.events, result.value.hasMore, result.value.projections)
      }
      this.openState = 'open'
    } catch (error) {
      if (generation !== this.openGeneration) return
      this.openState = 'error'
      this.externalDeltaBuffer = []
      const folded = transportError<never>(error)
      /* v8 ignore next -- the `? null` arm is unreachable: transportError always returns ok:false. */
      this.openError = folded.ok ? null : folded.error
    } finally {
      if (generation === this.openGeneration) this.notifier.markDirty()
    }
  }

  /** Install the history window + stitch the liveBuffer (seq is the sole dedup key).
   *  Stitching MUST NOT route through acceptLiveEvent: openState is still 'loading' here
   *  (doOpen flips it after install), so recursing would push every buffered event straight
   *  back into liveBuffer where nothing ever drains it — a silent drop loop.
   *  A carried projections block seeds the value store (higher seq wins, so a stale
   *  baseline cannot overwrite a newer push frame); the window events themselves are
   *  never folded — the host is the only computation site. */
  private installWindow(entries: HistoryEntry[], hasMore: boolean, projections?: ProjectionsBaseline): void {
    this.events = entries.map(e => e.event)
    this.views = entries.map(e => e.view)
    this.baseSeq = this.events[0]?.seq ?? 0
    this.hasMore = hasMore
    if (this.events.some(event => event.type === 'turn/start')) this.firstPromptPendingTurn = false
    this.conversation.replaceWindow(entries.map(conversationInput), hasMore)
    if (projections !== undefined) this.projections.seed(projections)
    // A prompt can start as soon as the composer is enabled, before the first
    // history request settles. Apply those transient deltas before durable
    // history so a committed agent message retires the matching live turn
    // instead of allowing a stale delta to resurrect after the baseline lands.
    const externalDeltas = this.externalDeltaBuffer
    this.externalDeltaBuffer = []
    for (const item of externalDeltas) this.externalLive.push(item.turnId, item.delta)
    const buffered = this.liveBuffer
    this.liveBuffer = []
    for (const item of buffered) this.appendLive(item.event, item.view)
    this.notifier.markDirty()
  }

  /** Seq-guarded append shared by stitching and the open-state live path. */
  private appendLive(event: SessionEvent, view?: ToolEventView): ConversationPublication {
    const externalChanged = this.retireExternalLive(event)
    const tailSeq = this.windowTailSeq()
    if (tailSeq !== null && event.seq <= tailSeq) return externalChanged ? 'immediate' : 'none' // replay overlap, drop
    this.observeExternalTurnEnd(event)
    this.events.push(event)
    this.views.push(view)
    if (event.type === 'turn/start') this.firstPromptPendingTurn = false
    const queueChanged = this.queueMirror.acceptDurable(event)
    const publication = this.conversation.append({ event, view })
    return externalChanged || queueChanged ? 'immediate' : publication
  }

  /** Land a live session/event (open/repair in flight -> buffer; overlapping seq -> drop;
   *  a seq gap -> buffer + tail-page repull instead of appending a hole (a gap is an
   *  expected reconnect-window artifact, repaired by refetch). The window stays one contiguous
   *  raw range, which lets Conversation Definitions correlate every recorded event between its
   *  ends and lets a compaction checkpoint resolve its cited summary event. */
  private acceptLiveEvent(event: SessionEvent, view?: ToolEventView): void {
    // Terminal events can arrive before a Session has opened or while its
    // history request is in flight. Observe them before the state gate; the
    // append path repeats the call for buffered/history entries and the
    // sequence guard makes that replay idempotent.
    this.observeExternalTurnEnd(event)
    if (this.openState === 'loading' || this.stitching) {
      this.liveBuffer.push({ event, view })
      return
    }
    if (this.openState !== 'open') return // cold/error: no window upkeep (history fully backfills on open)
    const tailSeq = this.windowTailSeq()
    if (tailSeq !== null && event.seq > tailSeq + 1) {
      this.liveBuffer.push({ event, view })
      void this.repairGap()
      return
    }
    this.scheduleConversation(this.appendLive(event, view))
  }

  /** Accept one transient external delta only for an open, healthy session. */
  private acceptExternalDelta(turnId: string, delta: string): void {
    if (this.removed || this.lastAgentError !== null) return
    if (this.openState === 'loading' || this.stitching) {
      this.externalDeltaBuffer.push({ turnId, delta })
      return
    }
    if (this.openState !== 'open') return
    if (this.externalLive.push(turnId, delta)) this.notifier.markFrameDirty()
  }

  /** Register a wait for the next durable external turn terminal event. */
  private waitForExternalTurnEnd(): ExternalTurnWaiter {
    let resolveWaiter!: () => void
    let rejectWaiter!: (error: unknown) => void
    let settled = false
    const minimumSeq = this.highestKnownSeq()
    const remove = (): void => {
      const index = this.externalTurnWaiters.indexOf(waiter)
      if (index !== -1) this.externalTurnWaiters.splice(index, 1)
    }
    const promise = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve
      rejectWaiter = reject
    })
    // A removal/error can reject before the command RPC itself returns. The
    // command attaches its awaited handler after that RPC, so install a
    // no-op observer now to keep that early rejection handled.
    void promise.catch(() => {})
    const waiter: ExternalTurnWaiter = {
      minimumSeq,
      armed: false,
      expectedTurnId: undefined,
      promise,
      arm: (turnId) => {
        if (settled) return
        waiter.armed = true
        waiter.expectedTurnId = turnId
        if (turnId === undefined) waiter.minimumSeq = Math.max(waiter.minimumSeq, this.highestKnownSeq())
        else {
          const terminalSeq = this.recentExternalTerminals.get(turnId)
          if (terminalSeq !== undefined && terminalSeq > waiter.minimumSeq) waiter.settle()
        }
      },
      settle: () => {
        if (settled) return
        settled = true
        remove()
        resolveWaiter()
      },
      fail: (error: unknown) => {
        if (settled) return
        settled = true
        remove()
        rejectWaiter(error)
      },
      cancel: () => {
        if (settled) return
        settled = true
        remove()
        resolveWaiter()
      },
    }
    this.externalTurnWaiters.push(waiter)
    return waiter
  }

  /** Observe a durable terminal once, including events received before open. */
  private observeExternalTurnEnd(event: SessionEvent): void {
    if ((event as unknown as { type: string }).type !== 'external/turn-ended') return
    if (event.seq <= this.lastObservedExternalTerminalSeq) return
    this.lastObservedExternalTerminalSeq = event.seq
    const turnId = (event as unknown as { data: { turnId: string } }).data.turnId
    this.recentExternalTerminals.set(turnId, event.seq)
    while (this.recentExternalTerminals.size > 32) {
      const oldest = this.recentExternalTerminals.keys().next().value
      if (oldest === undefined) break
      this.recentExternalTerminals.delete(oldest)
    }
    for (const waiter of this.externalTurnWaiters) {
      if (!waiter.armed || event.seq <= waiter.minimumSeq) continue
      if (waiter.expectedTurnId === undefined || waiter.expectedTurnId === turnId) {
        waiter.settle()
        break
      }
    }
  }

  /** Reject all barriers when their Session can no longer produce a terminal event. */
  private failExternalTurnWaiters(error: unknown): void {
    for (const waiter of [...this.externalTurnWaiters]) waiter.fail(error)
  }

  /** Highest durable sequence known to this Session at barrier creation time. */
  private highestKnownSeq(): number {
    let highest = Math.max(this.subscribedLastSeq ?? -1, this.lastObservedExternalTerminalSeq)
    for (const event of this.events) highest = Math.max(highest, event.seq)
    for (const item of this.liveBuffer) highest = Math.max(highest, item.event.seq)
    return highest
  }

  /** Whether this session is driven by a registered external provider. */
  private isExternalMode(): boolean {
    return this.sessionMode !== undefined && this.sessionMode !== 'dsh'
  }

  /** Retire transient output when its durable message/turn boundary arrives. */
  private retireExternalLive(event: SessionEvent): boolean {
    const type = (event as unknown as { type: string }).type
    switch (type) {
      case 'external/message-added': {
        const data = (event as unknown as { data: { role?: string; turnId: string } }).data
        if (data.role !== 'agent') return false
        return this.externalLive.commit(data.turnId)
      }
      case 'external/turn-ended': {
        const turnId = (event as unknown as { data: { turnId: string } }).data.turnId
        return this.externalLive.commit(turnId)
      }
      case 'external/session-ended':
        return this.externalLive.close()
      default:
        return false
    }
  }

  /** Reset the live accumulator and publish a lifecycle edge when needed. */
  private resetExternalLive(): void {
    const buffered = this.externalDeltaBuffer.length > 0
    this.externalDeltaBuffer = []
    if (!this.externalLive.clear() && !buffered) return
    this.notifier.markDirty()
  }

  /** Route assembler cadence into the Session's existing microtask/RAF notifier. */
  private scheduleConversation(publication: ConversationPublication): void {
    if (publication === 'immediate') this.notifier.markDirty()
    else if (publication === 'animation-frame') this.notifier.markFrameDirty()
  }

  /** Resync-lite: repull the tail page and stitch the liveBuffer through the shared
   *  installWindow path. No openState transition — the UI keeps the current window (no loading
   *  flash); events arriving meanwhile detour to liveBuffer via the stitching flag. */
  private async repairGap(): Promise<void> {
    /* v8 ignore next -- re-entry guard: acceptLiveEvent already detours to liveBuffer while stitching, so no second call reaches here. */
    if (this.stitching) return
    this.stitching = true
    const generation = this.openGeneration
    try {
      const { result } = await this.history({ maxMessages: PAGE_MESSAGES })
      // Failure or superseded by a full resync: drop — the resync path rebuilds and clears the buffer itself.
      if (result.ok && generation === this.openGeneration && this.openState === 'open') {
        this.installWindow(result.value.events, result.value.hasMore, result.value.projections)
      }
    } catch (error) {
      console.error('[web-runtime] gap repair failed:', error)
    } finally {
      this.stitching = false
    }
  }

  private windowTailSeq(): number | null {
    const tail = this.events[this.events.length - 1]
    return tail === undefined ? null : tail.seq
  }

  private buildSnapshot(): ConversationSnapshot {
    if (this.pendingCache === null || this.pendingCache.rev !== this.pendingRev) {
      this.pendingCache = { rev: this.pendingRev, value: [...this.pending.values()] }
    }
    const chat = (this.conversation.snapshot('chat') as ChatSnapshot | undefined) ?? EMPTY_CHAT_SNAPSHOT
    const legacy = chat.legacy
    return {
      sessionId: this.sessionId,
      views: this.conversation,
      chat,
      nodes: legacy.nodes,
      turnTimings: legacy.turnTimings,
      turnEnds: legacy.turnEnds,
      partial: legacy.partial,
      externalLive: this.externalLive.snapshot(),
      runningCalls: legacy.runningCalls,
      pending: this.pendingCache.value,
      queue: this.queueMirror.snapshot(),
      running: this.running,
      subagent: this.address === undefined
        ? null
        : { address: this.address, parentAvailable: this.parentAvailable },
      composerPhase: derivePhase(
        hasVisibleConversationContent(chat)
          || (!this.blankBit && !this.firstPromptPendingTurn)
          || this.running
          || this.pendingCache.value.length > 0,
        this.promptAttempted,
      ),
      removed: this.removed,
      openState: this.openState,
      openError: this.openError,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      promptError: this.promptError,
      blank: this.blankBit,
      lastAgentError: this.lastAgentError,
    }
  }

  /** Select ordinary or addressed history transport from the stored browser fact. */
  private history(payload: { beforeSeq?: number; maxMessages?: number }): Promise<RpcResponse<{
    events: HistoryEntry[]
    hasMore: boolean
    projections?: ProjectionsBaseline
  }>> {
    return this.address === undefined
      ? this.api.sessions.history({ sessionId: this.sessionId, ...payload })
      : this.api.subagents.history({ ...this.address, ...payload })
  }
}

/** Convert one wire history row into the assembler's transport-neutral input. */
function conversationInput(entry: HistoryEntry): ConversationEventInput {
  return { event: entry.event, view: entry.view }
}

/** A generic command row alone remains control-plane content; every other visible Chat Node activates the conversation. */
function hasVisibleConversationContent(chat: ChatSnapshot): boolean {
  return chat.order.some(key => chat.nodes.get(key)?.kind !== 'command')
}

/**
 * The composerPhase judgment — the single site that knows the predicate
 * (consumers switch on the result, never re-derive). A failed first prompt
 * stays engaging until an authoritative accepted-turn, running, or pending
 * signal arrives (retry semantics — see ComposerPhase).
 * @param hasContent - authoritative non-blank activity beyond a pending first
 *   prompt, visible non-command Chat content, a running turn, or a pending interaction.
 * @param promptAttempted - a prompt was initiated on this session object.
 * @returns the derived phase.
 */
function derivePhase(hasContent: boolean, promptAttempted: boolean): ComposerPhase {
  if (hasContent) return 'active'
  return promptAttempted ? 'engaging' : 'blank'
}
