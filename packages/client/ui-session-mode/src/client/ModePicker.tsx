/**
 * The session-mode picker on the new-session screen, beside the workspace
 * picker and the agent-preset chip.
 *
 * It chooses who drives the NEXT session — the native DSH agent loop (`dsh`,
 * implicit) or a registered external console agent (Codex, …) — and, for an
 * external mode, the initial model. The choice must reach `session.create`
 * itself (unlike the agent-preset chip, which folds into an existing blank
 * session): the host decides at creation whether to build a native Agent or
 * hand the bare session to the external bridge driver. So the picker's
 * `create()` submits creation carrying the staged mode + model instead of a
 * plain workspace connect.
 *
 * The catalog arrives from `session.externalModes`: external modes come from
 * the registry, and a mode whose model lookup failed still appears so the
 * picker can offer it with an inline reason and let the session default its
 * model. The native `dsh` row is always present.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutline16, IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the hero seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModeSeatState } from './seat-store.ts'
import { NATIVE_MODE } from './seat-store.ts'
import css from './ModePicker.module.css'

/** Registration-side business face for the hero picker. */
export interface ModePickerInjected {
  hooks: {
    /** Seat snapshot bound by the renderer as useModeSeat. */
    modeSeat: SnapshotStore<ModeSeatState>
  }
  /** Load the external-mode catalog when the picker first renders. */
  load: () => Promise<void>
  /** Stage one driver mode for the next session. */
  select: (mode: string) => void
  /** Stage one model of the selected external mode. */
  selectModel: (model: string) => void
  /** Submit creation carrying the staged mode + model. */
  create: () => Promise<void>
}

/** Full component props. */
export type ModePickerProps =
  PropsRuntime<'conversation.hero.sessionMode'>
  & PropsLocale<'sessionMode'>
  & InjectFace<ModePickerInjected>

/** The native driver's stable presentation, keyed by the reserved mode id. */
const NATIVE_ROW: { provider: string; labelKey: 'mode.native' } = {
  provider: NATIVE_MODE,
  labelKey: 'mode.native',
}

/**
 * Render the new-session mode picker: a chip that opens the mode rows (native
 * + external) and, for an external mode, a model seat.
 * @param props - composed slot props.
 * @returns the picker, or null when the deployment composes no external modes
 *   and nothing is staged (a pure-native host has nothing to offer beyond the
 *   always-on native row, which the hero shows by default).
 */
export function ModePicker({
  load, select, selectModel, useModeSeat, t,
}: ModePickerProps) {
  const state = useModeSeat(snapshot => snapshot)
  const [modeOpen, setModeOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  // Reconcile the staged mode against the loaded catalog once it lands.
  const stagedIsExternal = state.current !== '' && state.current !== NATIVE_MODE
  const currentMode = state.modes.find(mode => mode.provider === state.current)
  const label = state.current === '' || state.current === NATIVE_MODE
    ? t('mode.native')
    : currentMode?.label ?? state.current

  // Nothing meaningful to pick between for a pure-native host (no external
  // modes registered): the always-on native row is the hero's default, so the
  // picker offers nothing.
  if (state.modes.length === 0 && state.failures.length === 0) return null

  const modeItems = [
    {
      id: NATIVE_ROW.provider,
      label: (
        <span className={css.item}>
          <span className={css.itemName}>{t('mode.native')}</span>
        </span>
      ),
    },
    ...state.modes.map(mode => ({
      id: mode.provider,
      label: (
        <span className={css.item}>
          <span className={css.itemName}>{mode.label}</span>
          {mode.hasModels && (
            <span className={css.itemModels}>{t('mode.model')}</span>
          )}
        </span>
      ),
    })),
    ...state.failures.map(failure => ({
      id: failure.provider,
      label: (
        <span className={css.item}>
          <span className={css.itemName}>{failure.label}</span>
          <span className={css.itemFail} title={failure.message}>{t('mode.modelUnavailable')}</span>
        </span>
      ),
    })),
  ]

  const onModeSelect = (id: string): void => {
    setModeOpen(false)
    select(id)
    // Switching to dsh or past a mode clears the staged model seat.
    if (id === NATIVE_MODE) setModelOpen(false)
  }

  const modelSeat = stagedIsExternal && currentMode !== undefined
    ? (
      <Menu
        open={modelOpen}
        onClose={() => { setModelOpen(false) }}
        items={currentMode.hasModels
          ? currentMode.models.map(model => ({
            id: model.id,
            label: (
              <span className={css.item}>
                <span className={css.itemName}>{model.name}</span>
                {model.description !== undefined && (
                  <span className={css.itemDesc}>{model.description}</span>
                )}
              </span>
            ),
          }))
          : []}
        selectedId={state.model}
        onSelect={(id) => {
          setModelOpen(false)
          selectModel(id)
        }}
        align="start"
        portal
        anchor={(
          <button
            type="button"
            className={css.modelSeat}
            aria-haspopup="menu"
            aria-expanded={modelOpen}
            disabled={!currentMode.hasModels}
            onClick={() => { setModelOpen(value => !value) }}
          >
            <span className={css.modelLabel}>{t('mode.model')}</span>
            <span className={css.modelValue}>
              {state.model === undefined
                ? t('mode.modelDefault')
                : currentMode.models.find(m => m.id === state.model)?.name ?? state.model}
            </span>
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    )
    : null

  return (
    <div className={css.row}>
      <Menu
        open={modeOpen}
        onClose={() => { setModeOpen(false) }}
        items={modeItems}
        selectedId={state.current === '' ? NATIVE_MODE : state.current}
        onSelect={onModeSelect}
        align="start"
        portal
        anchor={(
          <button
            type="button"
            className={css.seat}
            aria-haspopup="menu"
            aria-expanded={modeOpen}
            title={state.error ?? t('mode.seatHint')}
            disabled={state.busy}
            onClick={() => { setModeOpen(value => !value) }}
          >
            <IconAgentPresetOutline16 className={css.seatIcon} />
            <span className={css.seatLabel}>{state.busy ? t('mode.busy') : label}</span>
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
      {modelSeat}
    </div>
  )
}
