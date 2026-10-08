/** Real profile, Settings and Workspace services with in-memory storage media. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { onTestFinished } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@knyazevai/dsh-app-boot'
import ConfigEditor from '@knyazevai/dsh-config-editor'
import Settings from '@knyazevai/dsh-settings'
import Storage from '@knyazevai/dsh-storage'
import { DomainFacility } from '@knyazevai/dsh-storage-domain'
import WorkspaceRegistry from '@knyazevai/dsh-workspace'
import { SESSION_FORMAT_VERSION, SessionId } from '@knyazevai/dsh-session'
import { SessionPersistenceRevision } from '@knyazevai/dsh-session-persistence'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import PinState from '../src/index.ts'

export async function fixture(legacyPins: string[] = []) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fork-pins-')))
  onTestFinished(() => rmSync(home, { recursive: true, force: true }))
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"pin-test"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'fork-workspace-session-state', name: 'cordis:pins' },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  if (legacyPins.length) writeFileSync(join(home, 'settings.yaml'), JSON.stringify({ 'fork-workspace-session-state': { pins: { sessionIds: legacyPins } } }))
  const profile: ProfileContext = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const pool = new MemoryMediaPool()
  const start = async () => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), async (ctx) => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, pins: PinState })
      await ctx.plugin(Storage)
      ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
      const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      ctx.provide('sessionPersistence', { list: async () => ['s1', 's2', 's3'].map(id => ({ header: { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: home }, revision: SessionPersistenceRevision(id) })) } as never)
      await ctx.plugin(WorkspaceRegistry)
    })
    onTestFinished(() => ctx.fiber.dispose())
    return ctx
  }
  return { ctx: await start(), start, home, profile }
}
