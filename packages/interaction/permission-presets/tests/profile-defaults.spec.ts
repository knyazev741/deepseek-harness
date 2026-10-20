/** Explicit permission choices persist through the real profile editor and fresh-session initialization. */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@knyazevai/dsh-app-boot'
import ConfigEditor from '@knyazevai/dsh-config-editor'
import Settings from '@knyazevai/dsh-settings'
import { withFileLock } from '@knyazevai/dsh-atomic-write'
import Commands from '@knyazevai/dsh-commands'
import Approval from '@knyazevai/dsh-user-approval'
import { SessionId } from '@knyazevai/dsh-session'
import {
  mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
} from '@knyazevai/dsh-agent-loop-testkit'
import PermissionPresets from '../src/index.ts'
import { createSessionTestRemote } from '../../../api/session-controller/tests/test-remote.ts'

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'permission-defaults-')))
  const contexts: Context[] = []
  onTestFinished(async () => {
    try {
      for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"permission-defaults-test"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'runtime', name: 'cordis:runtime' },
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'permission', name: 'cordis:permission', config: {
      defaultPreset: 'workspace-write',
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
    } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const runtime = {
    async apply(ctx: Context) {
      await mountAgentLoopTestDependencies(ctx)
      ctx.provide('shell', {
        sandboxMode: 'workspace-write',
        resolve() { throw new Error('permission tests do not execute shell commands') },
        run() { throw new Error('permission tests do not execute shell commands') },
        start() { throw new Error('permission tests do not execute shell commands') },
      })
      await ctx.plugin(Approval)
      await ctx.plugin(Commands)
      await mountAgentLoopTestHarness(ctx)
    },
  }
  const start = () => boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    contexts.push(ctx)
    ctx.provide('profileContext', profile)
    Object.assign(ctx.loader.builtins, {
      runtime, editor: ConfigEditor, settings: Settings, permission: PermissionPresets,
    })
  })
  const ctx = await start()
  let serial = 0
  const create = (owner: Context = ctx) => owner.agentLoop.create(
    SessionId(`permission-default-${String(serial++)}`), { provider: 'fixture', model: 'unused' }, { cwd: home },
  )
  return { ctx, start, create, profile }
}

it('uses the last selected configured preset for new sessions and after profile reload', async () => {
  const { ctx, start, create, profile } = await fixture()
  const first = await create()
  const signal = new AbortController().signal
  expect(ctx.permissionPresets.current(first.session)).toBe('workspace-write')
  await ctx.commands.execute(first, '/permission danger-full-access', [], signal)
  const second = await create()
  expect(ctx.permissionPresets.current(second.session)).toBe('danger-full-access')
  await ctx.commands.execute(first, '/permission workspace-write', [], signal)
  expect(ctx.permissionPresets.current((await create()).session)).toBe('workspace-write')
  expect(ctx.permissionPresets.current(second.session)).toBe('danger-full-access')
  await ctx.commands.execute(first, '/permission read-only', [], signal)
  expect(ctx.permissionPresets.current((await create()).session)).toBe('read-only')
  await ctx.commands.execute(first, '/permission danger-full-access', [], signal)
  expect(await readFile(profile.patchPath, 'utf8')).toContain('danger-full-access')
  await ctx.fiber.dispose()
  const reloaded = await start()
  expect(reloaded.permissionPresets.current((await create(reloaded)).session)).toBe('danger-full-access')
})

it('remembers a repeated explicit choice but does not learn defaults from programmatic changes or reads', async () => {
  const { ctx, create } = await fixture()
  const first = await create()
  const signal = new AbortController().signal
  ctx.permissionPresets.set(first.session, 'danger-full-access')
  await ctx.commands.execute(first, '/permission', [], signal)
  expect(ctx.permissionPresets.current((await create()).session)).toBe('workspace-write')
  await ctx.commands.execute(first, '/permission danger-full-access', [], signal)
  expect(ctx.permissionPresets.current((await create()).session)).toBe('danger-full-access')
})

it('reports a failed default save while keeping the already applied session permission', async () => {
  const { ctx, create } = await fixture()
  const first = await create()
  const update = vi.spyOn(ctx.settings, 'update').mockRejectedValueOnce(new Error('profile is read-only'))
  onTestFinished(() => { update.mockRestore() })
  const result = await ctx.commands.execute(first, '/permission danger-full-access', [], new AbortController().signal)
  expect(result?.result.kind).toBe('error')
  if (result?.result.kind !== 'error') throw new Error('expected the failed default save to be reported')
  expect(result.result.text).toContain('new sessions')
  expect(ctx.permissionPresets.current(first.session)).toBe('danger-full-access')
  expect(ctx.permissionPresets.current((await create()).session)).toBe('workspace-write')
})

it('keeps Auto session-local and rejects unknown choices without changing the default', async () => {
  const { ctx, create } = await fixture()
  const first = await create()
  await ctx.plugin({
    inject: ['permissionPresets'],
    apply(owner: Context) { owner.permissionPresets.registerAuto(() => {}) },
  })
  await ctx.commands.execute(first, '/permission auto', [], new AbortController().signal)
  expect(ctx.permissionPresets.current(first.session)).toBe('auto')
  const refused = await ctx.commands.execute(first, '/permission missing', [], new AbortController().signal)
  expect(refused?.result.kind).toBe('error')
  expect(ctx.permissionPresets.current((await create()).session)).toBe('workspace-write')
})

it.each([false, true])('waits for an admitted preference write before creating a chat (failure: %s)', async (fail) => {
  const { ctx, create, profile } = await fixture()
  const first = await create()
  const held = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const editing = Promise.withResolvers<undefined>()
  const running: Promise<unknown>[] = []
  const originalEdit = ctx.configEditor.edit.bind(ctx.configEditor)
  const intercept = vi.spyOn(ctx.configEditor, 'edit').mockImplementation((entry, change) => {
    const operation = originalEdit(entry, (current, inherited) => {
      if (fail) throw new Error('profile write refused')
      return change(current, inherited)
    })
    editing.resolve(undefined)
    return operation
  })
  const cleanup = async () => {
    release.resolve(undefined)
    await Promise.allSettled(running)
    intercept.mockRestore()
  }
  onTestFinished(cleanup)
  try {
    running.push(withFileLock(join(profile.dir, 'package.json'), async () => {
      held.resolve(undefined)
      await release.promise
    }))
    await held.promise
    const selection = ctx.commands.execute(first, '/permission danger-full-access', [], new AbortController().signal)
    running.push(selection)
    await editing.promise
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'unused' }), cwd: profile.cwd,
    })
    let returned = false
    const creation = remote.create({}).then((result) => { returned = true; return result })
    running.push(creation)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(returned).toBe(false)
    release.resolve(undefined)
    await selection
    const created = await creation
    if (!created.ok) throw created.error
    const session = ctx.sessions.get(created.value.sessionId)
    if (session === undefined) throw new Error('new Session was not published')
    expect(ctx.permissionPresets.current(session)).toBe(fail ? 'workspace-write' : 'danger-full-access')
  } finally {
    await cleanup()
  }
})
