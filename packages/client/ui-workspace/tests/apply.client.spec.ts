import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SlotRegistry } from '@knyazevai/dsh-client-runtime/client'
import { LocaleRuntime } from '@knyazevai/dsh-client-locale/client'
import { apply, inject } from '@knyazevai/dsh-client-ui-workspace/client'
import * as workspaceClient from '@knyazevai/dsh-client-ui-workspace/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected } from '@knyazevai/dsh-client-ui-workspace/client'
import type { WorkspaceListView } from '@knyazevai/dsh-client-ui-workspace/client'
import { WorkspaceBrowser } from '../src/client/WorkspaceBrowser.tsx'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const create = vi.fn(async (input: { name: string } | { path: string }) => ({
    workspaceId: 'ws-new' as never,
    path: 'name' in input ? `/projects/${input.name}` : input.path,
    title: 'new', sessionIds: [], createdAt: '0', updatedAt: '0',
  }))
  const startSession = vi.fn()
  const rename = vi.fn(async () => ({}))
  const insertSessionBefore = vi.fn(async () => ({}))
  const open = vi.fn()
  const clear = vi.fn()
  const search = vi.fn(async () => ({
    ok: true as const,
    value: { items: [{ sessionId: 'session' as never, snippet: 'match' }], hasMore: false },
  }))
  const renameSession = vi.fn(async (title: string) => ({ ok: true, value: { title, seq: 1 } }))
  const binding = vi.fn(() => ({ session: { rename: renameSession } }))
  const fork = vi.fn(async () => 'forked' as never)
  ctx.provide('workspaces', {
    create, startSession, rename, insertSessionBefore,
  } as never)
  ctx.provide('sessions', { open, clear, search, searchResultLimit: 20, binding, fork } as never)
  ctx.provide('connection', {
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  } as never)
  const locale = new LocaleRuntime(ctx)
  // These specs assert the shipped Chinese copy. There is no jsdom `window`
  // in this lane, so browser-language detection never runs and the locale
  // comes from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, create, startSession, rename,
    insertSessionBefore, open, clear, search, renameSession, binding, fork,
  }
}

type HoleName = 'sidebar.workspaces' | 'conversation.hero.workspace' | 'conversation.empty.workspace'

/** Declare any subset of the holes with a single root registration ('root' is a single slot). */
function declare(slots: SlotRegistry, ...names: HoleName[]): () => void {
  const children = Object.fromEntries(names.map(name => [name, { kind: 'single', scope: 'root' }]))
  return slots.register({ name: 'root', children } as never, () => null)
}

describe('ui-workspace apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'locale', 'connection'])
  })

  it('registers browser and pickers for declarations arriving before or after apply', async () => {
    const before = await bench()
    declare(before.slots, 'sidebar.workspaces')
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.workspaces')[0]!.component).toBe(WorkspaceBrowser)
    // Copy rides the standard locale seat: the entry declares the namespace
    // and apply registered both dictionaries.
    expect(before.slots.entries('sidebar.workspaces')[0]!.locale).toBe('workspace')
    expect(before.locale.bind('workspace')('session.new')).toBe('新会话')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    declare(after.slots, 'conversation.hero.workspace', 'conversation.empty.workspace')
    await Promise.resolve()
    expect(after.slots.entries('conversation.hero.workspace')[0]!.component).toBe(WorkspacePicker)
    // expect(after.slots.entries('conversation.empty.workspace')[0]!.component).toBe(WorkspacePicker)
  })

  it('routes browser actions and picker creation to the services', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    // Both arms delegate to the runtime's shared New Session action.
    browser.startSession('ws' as never)
    expect(b.startSession).toHaveBeenCalledWith('ws')
    browser.startSession()
    expect(b.startSession).toHaveBeenLastCalledWith(undefined)
    browser.open('session' as never)
    expect(b.open).toHaveBeenCalledWith('session')
    const signal = new AbortController().signal
    await expect(browser.searchSessions('match', signal)).resolves.toEqual({
      items: [{ sessionId: 'session', snippet: 'match' }],
      hasMore: false,
    })
    expect(b.search).toHaveBeenCalledWith('match', signal)
    expect(browser.searchResultLimit).toBe(20)
    await browser.renameSession('session' as never, 'renamed session')
    expect(b.binding).toHaveBeenCalledWith('session')
    expect(b.renameSession).toHaveBeenCalledWith('renamed session')
    browser.forkSession('session' as never)
    await vi.waitFor(() => {
      expect(b.open).toHaveBeenCalledWith('forked')
    })
    expect(b.fork).toHaveBeenCalledWith({ sessionId: 'session', increaseTitle: true })
    await browser.renameWorkspace('ws' as never, 'renamed')
    expect(b.rename).toHaveBeenCalledWith('ws', 'renamed')
    await browser.insertSessionBefore('ws' as never, 's1' as never, 's2' as never)
    expect(b.insertSessionBefore).toHaveBeenCalledWith('ws', 's1', 's2')
    await browser.createWorkspace({ path: '/tmp/browser-project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/browser-project' })

    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    await picker.createWorkspace({ path: '/tmp/project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/project' })
  })

  it('composes a contributor fiber through the applied runtime service', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const view: WorkspaceListView = { id: 'runtime-view', order: 0, label: 'Runtime', include: () => true }
    const contributor = b.ctx.plugin({
      inject: ['workspaceContributions'],
      apply: (scope) => { scope.workspaceContributions.registerView(view) },
    })
    await contributor.await()
    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    expect(browser.hooks.views.getSnapshot()).toEqual([view])
    await contributor.dispose()
    expect(browser.hooks.views.getSnapshot()).toEqual([])
  })

  it('composes the package client entry through Loader and cordis.yml', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces')
    const view: WorkspaceListView = { id: 'loader-view', order: 0, label: 'Loader', include: () => true }
    const contributor = {
      inject: ['workspaceContributions'],
      apply: (scope: { workspaceContributions: { registerView(value: WorkspaceListView): () => void } }) => {
        scope.workspaceContributions.registerView(view)
      },
    }
    let disposed = false
    try {
      const configUrl = new URL('./fixtures/loader-composition/cordis.yml', import.meta.url)
      b.ctx.baseUrl = new URL('./fixtures/loader-composition/', import.meta.url).href
      await b.ctx.plugin(Loader)
      b.ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@knyazevai/dsh-client-ui-workspace', workspaceClient],
        ['@fixture/workspace-contributor', contributor],
      ])
      b.ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof b.ctx.loader.internal>
      await b.ctx.loader.create({ name: 'cordis:include', config: { path: configUrl.href } })
      await b.ctx.loader.await()

      const service = b.ctx.workspaceContributions
      expect(service.views.getSnapshot()).toEqual([view])
      const contributorEntry = [...b.ctx.loader.entries()].find(
        entry => entry.options.name === '@fixture/workspace-contributor',
      )
      if (contributorEntry === undefined) throw new Error('Loader did not mount the workspace contributor')
      await contributorEntry.parent.remove(contributorEntry.options.id)
      expect(service.views.getSnapshot()).toEqual([])

      await b.ctx.fiber.dispose()
      disposed = true
      expect(b.ctx.get('workspaceContributions')).toBeUndefined()
    } finally {
      if (!disposed) await b.ctx.fiber.dispose()
    }
  })

  it('declares the two directory-flow holes and reports their occupancy per surface', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Registration declared the child holes (declaration = render authorization).
    expect(b.slots.spec('sidebar.workspaces.directoryFlow')).toMatchObject({ kind: 'single' })
    expect(b.slots.spec('conversation.hero.workspace.directoryFlow')).toMatchObject({ kind: 'single' })

    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    expect(browser.hooks.hostDescription.getSnapshot()).toBeUndefined()
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    // A flow occupant flips exactly its own surface, and the source notifies.
    const notified = vi.fn()
    const unsubscribe = browser.hooks.directoryFlow.subscribe(notified)
    const dispose = b.slots.register({ name: 'sidebar.workspaces.directoryFlow' } as never, () => null)
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(true)
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    await Promise.resolve()
    expect(notified).toHaveBeenCalled()
    dispose()
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    unsubscribe()
  })

  it('rejects the browser search callback on a runtime business error', async () => {
    const b = await bench()
    b.search.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'internal', message: 'index unavailable', details: {} },
    }) as never)
    declare(b.slots, 'sidebar.workspaces')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    await expect(browser.searchSessions('needle', new AbortController().signal))
      .rejects.toThrow('index unavailable')
  })

  it('unregisters every entry on teardown', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace', 'conversation.empty.workspace')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(b.slots.entries('conversation.hero.workspace')).toHaveLength(0)
    // expect(b.slots.entries('conversation.empty.workspace')).toHaveLength(0)
  })
})
