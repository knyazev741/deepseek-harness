/**
 * Hero mode-picker controller: which driver the NEXT session gets and which
 * initial model it starts with.
 *
 * The new-session screen has no session, so a pick is staged rather than
 * applied. Unlike the agent-preset chip — whose choice the host can fold into
 * an already-created blank session — the mode must ride `session.create`
 * itself: the host decides at creation whether to build a native Agent or hand
 * the bare session to an external bridge driver. So this controller exposes a
 * `create()` that submits creation with the staged mode + model; the hero
 * surface calls it in place of the plain workspace connect.
 *
 * The catalog comes from the host's `session.externalModes` RPC: every
 * registered external mode with its disclosed model directory. A mode whose
 * model lookup failed still appears (in `failures`) so the picker can offer it
 * with an inline reason and let the session default its model.
 */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/** The native driver presented alongside the registered external modes. */
export const NATIVE_MODE = 'dsh'

/** One external mode the picker can offer, with its models when disclosed. */
export interface ModeOption {
  /** Registry name; also the `session.create` mode value. */
  provider: string
  /** Mode display label. */
  label: string
  /** Whether a model seat is available for this mode. */
  hasModels: boolean
  /** Models in provider-preferred order; empty when the mode offers none. */
  models: readonly ModeModel[]
}

/** One selectable model inside an external mode. */
export interface ModeModel {
  /** Provider-owned model id. */
  id: string
  /** Human-readable model name. */
  name: string
  /** Optional user-facing distinction. */
  description?: string
}

/** A mode whose model catalog lookup failed; the mode itself stays selectable. */
export interface ModeFailure {
  /** Registry name / mode id. */
  provider: string
  /** Mode display label. */
  label: string
  /** Lookup failure diagnostic shown as the seat's inline reason. */
  message: string
}

/** Hero picker snapshot. */
export interface ModeSeatState {
  /** External modes in registry order; the native `dsh` row is implicit. */
  modes: readonly ModeOption[]
  /** Modes whose model lookup failed (still selectable, with a reason). */
  failures: readonly ModeFailure[]
  /** Staged driver: `dsh` or an external provider name. */
  current: string
  /** Staged initial model for the selected external mode, when chosen. */
  model: string | undefined
  /** A catalog load or creation error's message, cleared by the next attempt. */
  error: string | null
  /** A catalog load or creation is in flight. */
  busy: boolean
}

const INITIAL: ModeSeatState = {
  modes: [], failures: [], current: '', model: undefined, error: null, busy: false,
}

/**
 * Stages the next session's driver mode and initial model, and submits
 * creation carrying them.
 */
export class ModeSeatController {
  /** Picker snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<ModeSeatState> = createSnapshotStore(INITIAL)

  constructor(
    private readonly api: Pick<IApiClient, 'sessions'>,
    /** Submit creation carrying the staged mode + model. */
    private readonly createSession: (mode: string, model: string | undefined) => Promise<void>,
  ) {}

  private set(patch: Partial<ModeSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /** Load the external-mode catalog from the host. */
  async load(): Promise<void> {
    this.set({ busy: true, error: null })
    try {
      const response = await this.api.sessions.externalModes({})
      if (!response.result.ok) {
        this.set({ busy: false, error: response.result.error.message })
        return
      }
      const { groups, failures } = response.result.value
      const modes: ModeOption[] = groups.map(group => ({
        provider: group.provider,
        label: group.label,
        hasModels: group.models.length > 0,
        models: group.models.map(model => ({
          id: model.id,
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
        })),
      }))
      const previous = this.store.getSnapshot()
      const stillPresent = modes.some(mode => mode.provider === previous.current)
      // A staged external mode that left the catalog falls back to dsh; a
      // staged model whose provider vanished (or was never chosen) is dropped.
      this.set({
        modes,
        failures: failures.map(failure => ({
          provider: failure.provider,
          label: failure.label,
          message: failure.message,
        })),
        current: stillPresent ? previous.current : 'dsh',
        model: stillPresent ? previous.model : undefined,
        busy: false,
      })
    } catch (error: unknown) {
      this.set({
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Stage one driver mode for the next session.
   * @param mode - `dsh` or an external provider name.
   */
  select(mode: string): void {
    const current = this.store.getSnapshot().current
    // Switching modes clears a staged model: a model id belongs to its provider.
    this.set({ current: mode, model: mode === 'dsh' || mode !== current ? undefined : this.store.getSnapshot().model })
  }

  /**
   * Stage one model of the currently selected external mode.
   * @param model - a provider-owned model id from the selected mode's list.
   */
  selectModel(model: string): void {
    const snapshot = this.store.getSnapshot()
    // Only meaningful for an external mode that discloses models.
    if (snapshot.current === 'dsh') return
    this.set({ model })
  }

  /** The external mode the picker currently offers the model seat for. */
  currentMode(): ModeOption | undefined {
    const snapshot = this.store.getSnapshot()
    return snapshot.modes.find(mode => mode.provider === snapshot.current)
  }

  /**
   * Submit creation of the next session carrying the staged mode + model.
   * @returns a rejected promise when the host refuses creation.
   */
  async create(): Promise<void> {
    const snapshot = this.store.getSnapshot()
    if (snapshot.busy) return
    this.set({ busy: true, error: null })
    try {
      await this.createSession(snapshot.current, snapshot.model)
      this.set({ busy: false })
    } catch (error: unknown) {
      this.set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
