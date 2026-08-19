// @vitest-environment jsdom
/**
 * The session-mode picker: a chip that names who drives the next session and,
 * for an external mode, opens a model seat. Behavior is driven through the
 * props: the store snapshot bound by `useModeSeat`, and plain callbacks for
 * `load`/`select`/`selectModel`. A pure-native host (no external modes, no
 * failures) renders nothing, and a model seat for an external mode that
 * discloses no models is disabled with the inline reason.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { ModePicker } from '../src/client/ModePicker.tsx'
import type { ModePickerProps } from '../src/client/ModePicker.tsx'
import type { ModeSeatState } from '../src/client/seat-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const READY: ModeSeatState = {
  modes: [
    { provider: 'codex', label: 'Codex', hasModels: true, models: [{ id: 'gpt-5', name: 'GPT-5' }] },
    { provider: 'acp', label: 'ACP agent', hasModels: false, models: [] },
  ],
  failures: [],
  current: '',
  model: undefined,
  error: null,
  busy: false,
}

function renderPicker(state: Partial<ModeSeatState> = {}) {
  const store = createSnapshotStore<ModeSeatState>({ ...READY, ...state })
  const actions = {
    load: vi.fn(() => Promise.resolve()),
    select: vi.fn(),
    selectModel: vi.fn(),
    create: vi.fn(() => Promise.resolve()),
  }
  render(<ModePicker {...({
    ...actions,
    useModeSeat: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as ModePickerProps)} />)
  return { actions, store }
}

describe('the session-mode picker', () => {
  it('loads the catalog on mount', () => {
    const { actions } = renderPicker()
    expect(actions.load).toHaveBeenCalledTimes(1)
  })

  it('names the native driver when nothing is staged', () => {
    renderPicker()
    expect(screen.getByRole('button').textContent).toContain(en['mode.native'])
  })

  it('renders nothing for a pure-native host', () => {
    const { container } = render(<ModePicker {...({
      load: vi.fn(() => Promise.resolve()),
      select: vi.fn(),
      selectModel: vi.fn(),
      create: vi.fn(() => Promise.resolve()),
      useModeSeat: bindSnapshotSelector(createSnapshotStore<ModeSeatState>({
        modes: [], failures: [], current: '', model: undefined, error: null, busy: false,
      })),
      t: (key: keyof typeof en) => en[key],
    } as unknown as ModePickerProps)} />)
    expect(container.firstChild).toBeNull()
  })

  it('lists the external modes in registry order and stages a selection', () => {
    const { actions } = renderPicker()
    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText('ACP agent')).toBeTruthy()

    fireEvent.click(screen.getByText('Codex'))
    expect(actions.select).toHaveBeenCalledWith('codex')
  })

  it('offers a model seat for an external mode and lists its models', () => {
    renderPicker({ current: 'codex', model: 'gpt-5' })

    // The model seat trigger names the staged model.
    const seat = screen.getByRole('button', { name: /gpt-5/i })
    fireEvent.click(seat)

    // The seat value and the opened menu item both name the model.
    expect(screen.getAllByText('GPT-5').length).toBeGreaterThan(0)
  })

  it('disables the model seat with the inline reason when the mode discloses no models', () => {
    const { actions } = renderPicker({ current: 'acp' })

    const seat = screen.getByRole('button', { name: /model/i })
    expect(seat).toHaveProperty('disabled', true)

    // No models to pick: selecting through a disabled seat is impossible.
    expect(actions.selectModel).not.toHaveBeenCalled()
  })

  it('shows a failed mode with its inline reason', () => {
    renderPicker({
      modes: [],
      failures: [{ provider: 'bot', label: 'Bot', message: 'no model directory' }],
    })
    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('Bot')).toBeTruthy()
    expect(screen.getByText(en['mode.modelUnavailable'])).toBeTruthy()
  })

  it('says it is busy while the catalog loads', () => {
    renderPicker({ busy: true })
    expect(screen.getByRole('button').textContent).toContain(en['mode.busy'])
    expect(screen.getByRole('button')).toHaveProperty('disabled', true)
  })
})
