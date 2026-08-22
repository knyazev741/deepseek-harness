/**
 * The hero mode-seat controller: it turns one `session.externalModes` catalog
 * into an ordered option list plus a failures list, falls a staged external
 * mode back to the native driver when it leaves the catalog, clears a staged
 * model when the selected mode changes, and submits creation carrying the
 * staged mode + model through the injected `createSession` callback.
 */

import { describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { ExternalModeFailure, ExternalModeGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { ModeSeatController } from '../src/client/seat-store.ts'

/** One external mode usable both by the fake catalog and the assertions. */
function group(
  provider: string,
  label: string,
  models: { id: string; name: string; description?: string }[],
): ExternalModeGroup {
  return { provider, label, modelDirectory: 'config', models }
}

/**
 * A client whose `session.externalModes` answers the test controls. The
 * `state` reference is shared, so mutating it between `load()` calls drives a
 * reload against a changed catalog.
 */
interface FakeState {
  groups: ExternalModeGroup[]
  failures: ExternalModeFailure[]
  failWith?: Error
  // When set, externalModes resolves with ok:false and this message.
  failResolve?: string
}

function fakeApi(state: FakeState): Pick<IApiClient, 'sessions'> {
  return {
    sessions: {
      externalModes: () =>
        state.failWith !== undefined
          ? Promise.reject(state.failWith)
          : state.failResolve !== undefined
            ? Promise.resolve({
              rpcId: 'r',
              result: { ok: false as const, error: { code: 'internal', message: state.failResolve, details: {} } },
            })
            : Promise.resolve({
              rpcId: 'r',
              result: { ok: true as const, value: { groups: state.groups, failures: state.failures } },
            }),
    },
  } as unknown as Pick<IApiClient, 'sessions'>
}

describe('the hero mode-seat controller', () => {
  it('maps one catalog into modes and failures with no staged driver', async () => {
    const controller = new ModeSeatController(
      fakeApi({
        groups: [
          group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'sonnet', name: 'Sonnet' }]),
          group('acp', 'ACP agent', []),
        ],
        failures: [{ provider: 'bot', label: 'Bot', message: 'no model directory' }],
      }),
      vi.fn(),
    )

    await controller.load()

    const snapshot = controller.store.getSnapshot()
    expect(snapshot.busy).toBe(false)
    expect(snapshot.error).toBeNull()
    expect(snapshot.modes).toHaveLength(2)
    expect(snapshot.modes[0]).toMatchObject({ provider: 'codex', label: 'Codex', hasModels: true })
    expect(snapshot.modes[0]?.models).toEqual([
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'sonnet', name: 'Sonnet' },
    ])
    expect(snapshot.modes[1]).toMatchObject({ provider: 'acp', label: 'ACP agent', hasModels: false })
    // No stage happened, so the picker lands on the native driver.
    expect(snapshot.current).toBe('dsh')
    expect(snapshot.failures).toEqual([{ provider: 'bot', label: 'Bot', message: 'no model directory' }])
  })

  it('clears a staged model when switching modes and ignores one for the native driver', async () => {
    const controller = new ModeSeatController(
      fakeApi({ groups: [group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5' }])], failures: [] }),
      vi.fn(),
    )
    await controller.load()

    expect(controller.store.getSnapshot().current).toBe('dsh')
    controller.selectModel('nonsense')
    expect(controller.store.getSnapshot().model).toBeUndefined()

    controller.select('codex')
    controller.selectModel('gpt-5')
    expect(controller.store.getSnapshot().model).toBe('gpt-5')

    controller.select('acp')
    expect(controller.store.getSnapshot().model).toBeUndefined()

    // Back to codex: a fresh different model supplants the cleared one.
    controller.select('codex')
    controller.selectModel('sonnet')
    expect(controller.store.getSnapshot().model).toBe('sonnet')
  })

  it('keeps the staged model when re-selecting the same external mode', async () => {
    const controller = new ModeSeatController(
      fakeApi({ groups: [group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5' }])], failures: [] }),
      vi.fn(),
    )
    await controller.load()

    controller.select('codex')
    controller.selectModel('gpt-5')
    // Re-selecting the same provider is a no-op for the staged model.
    controller.select('codex')
    expect(controller.store.getSnapshot().model).toBe('gpt-5')
  })

  it('resolves the current external mode and reports none when staged absent', async () => {
    const controller = new ModeSeatController(
      fakeApi({ groups: [group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5' }])], failures: [] }),
      vi.fn(),
    )
    await controller.load()

    expect(controller.currentMode()).toBeUndefined()
    controller.select('codex')
    expect(controller.currentMode()).toMatchObject({ provider: 'codex' })
    controller.select('ghost')
    expect(controller.currentMode()).toBeUndefined()
  })

  it('does not submit creation while a load or create is in flight', async () => {
    const createSession = vi.fn(() => Promise.resolve())
    const controller = new ModeSeatController(
      fakeApi({ groups: [group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5' }])], failures: [] }),
      createSession,
    )
    await controller.load()
    controller.select('codex')

    controller.store.set({ ...controller.store.getSnapshot(), busy: true })
    await controller.create()

    expect(createSession).not.toHaveBeenCalled()
  })

  it('keeps a staged mode present in a reloaded catalog', async () => {
    const state: FakeState = { groups: [group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5' }])], failures: [] }
    const controller = new ModeSeatController(fakeApi(state), vi.fn())
    await controller.load()

    controller.select('codex')
    controller.selectModel('gpt-5')

    // Same catalog reload: the staged mode and model survive.
    await controller.load()
    expect(controller.store.getSnapshot().current).toBe('codex')
    expect(controller.store.getSnapshot().model).toBe('gpt-5')
  })

  it('falls a staged external mode that left the catalog back to native and drops its model', async () => {
    const state: FakeState = { groups: [group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5' }])], failures: [] }
    const controller = new ModeSeatController(fakeApi(state), vi.fn())
    await controller.load()

    controller.select('codex')
    controller.selectModel('gpt-5')

    // Codex leaves the registry on the next load.
    state.groups = [group('acp', 'ACP agent', [])]
    await controller.load()

    expect(controller.store.getSnapshot().current).toBe('dsh')
    expect(controller.store.getSnapshot().model).toBeUndefined()
  })

  it('submits creation carrying the staged mode + model', async () => {
    const createSession = vi.fn(() => Promise.resolve())
    const controller = new ModeSeatController(
      fakeApi({ groups: [group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5' }])], failures: [] }),
      createSession,
    )
    await controller.load()

    controller.select('codex')
    controller.selectModel('gpt-5')
    await controller.create()

    expect(createSession).toHaveBeenCalledWith('codex', 'gpt-5')
    expect(controller.store.getSnapshot().busy).toBe(false)
    expect(controller.store.getSnapshot().error).toBeNull()
  })

  it('carries a disclosed model description through the catalog load', async () => {
    const controller = new ModeSeatController(
      fakeApi({ groups: [group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5', description: 'flagship' }])], failures: [] }),
      vi.fn(),
    )
    await controller.load()
    expect(controller.store.getSnapshot().modes[0]?.models)
      .toEqual([{ id: 'gpt-5', name: 'GPT-5', description: 'flagship' }])
  })

  it('surfaces a refused catalog load as an error', async () => {
    const controller = new ModeSeatController(fakeApi({ groups: [], failures: [], failResolve: 'not allowed' }), vi.fn())
    await controller.load()
    expect(controller.store.getSnapshot().error).toBe('not allowed')
    expect(controller.store.getSnapshot().busy).toBe(false)
  })

  it('stringifies a non-Error catalog rejection', async () => {
    const controller = new ModeSeatController(fakeApi({ groups: [], failures: [], failWith: 'oops' as unknown as Error }), vi.fn())
    await controller.load()
    expect(controller.store.getSnapshot().error).toBe('oops')
  })

  it('reads an Error catalog rejection message', async () => {
    const controller = new ModeSeatController(fakeApi({ groups: [], failures: [], failWith: new Error('boom') }), vi.fn())
    await controller.load()
    expect(controller.store.getSnapshot().error).toBe('boom')
  })

  it('stringifies a non-Error create rejection', async () => {
    const controller = new ModeSeatController(
      fakeApi({ groups: [group('codex', 'Codex', [{ id: 'gpt-5', name: 'GPT-5' }])], failures: [] }),
      () => Promise.reject('refused' as unknown as Error),
    )
    await controller.load()
    controller.select('codex')
    await controller.create()
    expect(controller.store.getSnapshot().error).toBe('refused')
    expect(controller.store.getSnapshot().busy).toBe(false)
  })
})
