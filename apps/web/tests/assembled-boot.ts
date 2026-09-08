// Shared scaffolding for the assembled-jsdom snapshots: the real built
// workspace `lib/client.js` artifacts booted through AppWebEntry's
// ModuleLoader path (loadBundle) against the keyless FixtureApiClient
// transport. Every file that mounts this graph needs the same boot entry list,
// the same bundle map, the same jsdom globals, and the same mount call, and
// differs only in what it asserts afterwards, so the scaffolding lives here.
//
// Keyless and deterministic: the fixture is the fake server, so nothing here
// reaches a model or the network.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { bootInjections, orderByModuleGraph } from '@knyazevai/dsh-client-modules'
import type { ClientModuleLoaderTarget, WebBootEntry } from '@knyazevai/dsh-client-modules/client'
import { AppWebEntry } from '@knyazevai/dsh-client-web'

export type AssembledWebProfile = 'web' | 'fork-web'

interface AssembledPlugin extends WebBootEntry {
  /** Absolute path to the built client artifact declared by this package. */
  bundlePath: string
}

interface ClientPackageManifest {
  name?: string
  exports?: Record<string, string | { default?: string }>
  dsh?: {
    client?: {
      platform?: string
      inject?: string[]
      external?: string[]
      immediately?: boolean
    }
  }
}

interface ComposedEntry {
  name?: unknown
  disabled?: unknown
}

interface BootComposition {
  loadOverlayPatches(binName: string, file: string): unknown[]
  composeEntries(layers: readonly unknown[][]): ComposedEntry[]
}

const REPO_ROOT = process.cwd()
const PROFILE_LAYERS: Record<AssembledWebProfile, readonly {
  manifest: string
  patch: string
}[]> = {
  web: [
    {
      manifest: join(REPO_ROOT, 'packages/bundle/base/package.json'),
      patch: join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml'),
    },
    {
      manifest: join(REPO_ROOT, 'packages/bundle/web-app/package.json'),
      patch: join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml'),
    },
  ],
  'fork-web': [
    {
      manifest: join(REPO_ROOT, 'packages/bundle/base/package.json'),
      patch: join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml'),
    },
    {
      manifest: join(REPO_ROOT, 'packages/bundle/web-app/package.json'),
      patch: join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml'),
    },
    {
      manifest: join(REPO_ROOT, 'packages/bundle/fork-base/package.json'),
      patch: join(REPO_ROOT, 'packages/bundle/fork-base/cordis.patch.yml'),
    },
    {
      manifest: join(REPO_ROOT, 'packages/bundle/fork-web/package.json'),
      patch: join(REPO_ROOT, 'packages/bundle/fork-web/cordis.patch.yml'),
    },
  ],
}

const webBundleResolver = createRequire(PROFILE_LAYERS.web[1]!.manifest)
if (webBundleResolver === undefined) throw new Error('assembled boot: web bundle resolver missing')
const appBoot = await import(pathToFileURL(webBundleResolver.resolve('@knyazevai/dsh-app-boot')).href) as unknown as BootComposition

/*
 * The keyless FixtureApiClient predates the fork Host Remote. This browser-only
 * test seam supplies the generated namespace with an in-memory CAS and marks
 * one resident fixture row as GitHub Actions. The application still boots the
 * real built fork bundle; the seam only replaces the unavailable Host calls.
 */
const FORK_FIXTURE_PLUGIN_ID = '@knyazevai/dsh-fork-web-smoke-fixture'
const FORK_FIXTURE_PLUGIN_URL = `/plugins/${FORK_FIXTURE_PLUGIN_ID}/client.js?rev=fx`
const FORK_FIXTURE_PLUGIN_CODE = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(FORK_FIXTURE_PLUGIN_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const inject = ["remote", "remote.forkWorkspaceSessionState", "sessions"];
    function apply(ctx) {
      ctx.effect(() => {
        const namespace = ctx.remote.forkWorkspaceSessionState;
        let revision = 1;
        let pinnedSessionIds = [];
        const list = () => Promise.resolve({
          ok: true,
          value: { revision, pinnedSessionIds: [...pinnedSessionIds] },
        });
        const setPinned = (input) => {
          pinnedSessionIds = input.pinned
            ? [...new Set([...pinnedSessionIds, input.sessionId])]
            : pinnedSessionIds.filter((id) => id !== input.sessionId);
          revision += 1;
          return Promise.resolve({
            ok: true,
            value: { ok: true, value: { revision, pinnedSessionIds: [...pinnedSessionIds] } },
          });
        };
        const priorList = namespace.list;
        const priorSetPinned = namespace.setPinned;
        Object.defineProperty(namespace, "list", { configurable: true, enumerable: true, value: list });
        Object.defineProperty(namespace, "setPinned", { configurable: true, enumerable: true, value: setPinned });

        const store = ctx.sessions.list;
        const priorGetSnapshot = store.getSnapshot;
        let rawSnapshot;
        let projectedSnapshot;
        const getSnapshot = () => {
          const snapshot = priorGetSnapshot();
          if (snapshot === rawSnapshot) return projectedSnapshot;
          rawSnapshot = snapshot;
          const candidate = snapshot.byId["fx-beta"];
          if (candidate === undefined) {
            projectedSnapshot = snapshot;
            return projectedSnapshot;
          }
          projectedSnapshot = {
            ...snapshot,
            byId: {
              ...snapshot.byId,
              "fx-beta": {
                ...candidate,
                projectionValues: {
                  ...candidate.projectionValues,
                  forkSessionSource: "github-actions",
                },
              },
            },
          };
          return projectedSnapshot;
        };
        Object.defineProperty(store, "getSnapshot", { configurable: true, value: getSnapshot });
        return () => {
          Object.defineProperty(namespace, "list", { configurable: true, enumerable: true, value: priorList });
          Object.defineProperty(namespace, "setPinned", { configurable: true, enumerable: true, value: priorSetPinned });
          Object.defineProperty(store, "getSnapshot", { configurable: true, value: priorGetSnapshot });
        };
      }, "fork-web smoke: fixture Host overlay");
    }
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});`

function profileLayers(profile: AssembledWebProfile): readonly {
  manifest: string
  patch: string
}[] {
  return PROFILE_LAYERS[profile]
}

function profileResolvers(profile: AssembledWebProfile): ReturnType<typeof createRequire>[] {
  return profileLayers(profile).map(layer => createRequire(layer.manifest))
}

function resolvePackageManifest(
  specifier: string,
  resolvers: readonly ReturnType<typeof createRequire>[],
): string | undefined {
  for (const require of resolvers) {
    try {
      return require.resolve(`${specifier}/package.json`)
    } catch {
      continue
    }
  }
  return undefined
}

function resolveClientExport(packagePath: string, pkg: ClientPackageManifest): string {
  const declared = pkg.exports?.['./client']
  const relative = typeof declared === 'string' ? declared : declared?.default
  if (relative === undefined) {
    throw new Error(`assembled boot: ${pkg.name ?? packagePath} declares dsh.client without a ./client export`)
  }
  return resolve(dirname(packagePath), relative)
}

/** Derive the assembled browser graph from the same bundle patches and package declarations as `dsh web`. */
function loadAssembledPlugins(profile: AssembledWebProfile): readonly AssembledPlugin[] {
  const layers = profileLayers(profile)
  const resolvers = profileResolvers(profile)
  const entries = appBoot.composeEntries(layers.map(layer =>
    appBoot.loadOverlayPatches('assembled boot', layer.patch)))
  const plugins = new Map<string, AssembledPlugin>()
  for (const entry of entries) {
    if (entry.disabled === true || typeof entry.name !== 'string') continue
    const packagePath = resolvePackageManifest(entry.name, resolvers)
    if (packagePath === undefined) continue
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as ClientPackageManifest
    const declaration = pkg.dsh?.client
    if (declaration?.platform !== 'web') continue
    if (pkg.name !== entry.name) {
      throw new Error(`assembled boot: ${entry.name} resolved package ${pkg.name ?? '<unnamed>'}`)
    }
    plugins.set(entry.name, {
      id: entry.name,
      bundlePath: resolveClientExport(packagePath, pkg),
      url: `/plugins/${entry.name}/client.js?rev=fx`,
      rev: 'fx',
      ...(declaration.inject === undefined ? {} : { inject: declaration.inject }),
      ...(declaration.external === undefined ? {} : { external: declaration.external }),
      ...(declaration.immediately === true ? { immediately: true } : {}),
    })
  }
  if (profile === 'fork-web') {
    plugins.set(FORK_FIXTURE_PLUGIN_ID, {
      id: FORK_FIXTURE_PLUGIN_ID,
      bundlePath: '',
      url: FORK_FIXTURE_PLUGIN_URL,
      rev: 'fx',
      inject: ['remote', 'remote.forkWorkspaceSessionState', 'sessions'],
    })
  }
  return orderByModuleGraph([...plugins.values()]).map(({ id }) => {
    const plugin = plugins.get(id)
    /* v8 ignore next -- orderByModuleGraph returns the input row identities */
    if (plugin === undefined) throw new Error(`assembled boot: ordered unknown client package ${id}`)
    return plugin
  })
}

const DEFAULT_PLUGINS = loadAssembledPlugins('web')

function loadBundles(
  plugins: readonly AssembledPlugin[],
): ReadonlyMap<string, string> {
  return new Map(plugins.map(plugin => [
    plugin.url,
    plugin.id === FORK_FIXTURE_PLUGIN_ID
      ? FORK_FIXTURE_PLUGIN_CODE
      : readFileSync(plugin.bundlePath, 'utf8'),
  ]))
}

interface FixtureWindow extends Window {
  __DSH_BOOT__?: { rev: string; entries: WebBootEntry[] }
  __ModuleLoader__?: ClientModuleLoaderTarget
}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

class EventSourceStub {
  addEventListener(): void {}
  close(): void {}
}

const win = window as FixtureWindow
let unmount: (() => Promise<void>) | undefined

/**
 * Register the per-test jsdom setup and teardown the assembled boot needs:
 * English pinned before boot so role/text locators stay deterministic across
 * localized component migrations (the newEnglishPage e2e convention), the
 * observers and frame callbacks jsdom lacks, and a full reset of the document,
 * the boot globals, and the injected plugin styles afterwards.
 */
export function installAssembledBootEnv(): void {
  beforeEach(() => {
    localStorage.clear()
    // The locale service derives its provisional locale from the browser and
    // takes an explicit choice only from Host settings, which this lane's
    // fixture transport does not serve; pinning the navigator is what selects
    // English here.
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true })
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    document.title = 'DeepSeek Harness'
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('EventSource', EventSourceStub)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => { callback(0) }, 0) as unknown as number)
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
  })

  afterEach(async () => {
    await act(async () => { await unmount?.() })
    unmount = undefined
    cleanup()
    delete win.__DSH_BOOT__
    delete win.__ModuleLoader__
    document.body.innerHTML = ''
    document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
    document.title = ''
    history.replaceState(null, '', '/')
    // Deleting the own properties uncovers jsdom's own accessors again
    // (Navigator declares both readonly, hence the erased receiver).
    const ownNavigator = navigator as unknown as Record<string, unknown>
    delete ownNavigator.languages
    delete ownNavigator.language
    vi.unstubAllGlobals()
  })
}

/**
 * Mount the assembled application on the fixture transport; the teardown
 * registered by installAssembledBootEnv disposes it.
 * @param search - fixture query string used to select deterministic host behavior.
 */
export function mountAssembledApp(
  searchOrOptions: string | { search?: string; profile?: AssembledWebProfile } = '?fixture',
): void {
  const search = typeof searchOrOptions === 'string' ? searchOrOptions : searchOrOptions.search ?? '?fixture'
  const profile = typeof searchOrOptions === 'string' ? 'web' : searchOrOptions.profile ?? 'web'
  const plugins = profile === 'web' ? DEFAULT_PLUGINS : loadAssembledPlugins(profile)
  const bundles = loadBundles(plugins)
  history.replaceState(null, '', `/${search}`)
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  win.__DSH_BOOT__ = { rev: 'fx', entries: plugins.map(({ bundlePath: _bundlePath, ...plugin }) => plugin) }
  const [facadeRow] = bootInjections(win.__DSH_BOOT__)
  if (facadeRow?.kind !== 'script') throw new Error('missing injected ModuleLoader facade row')
  ;(0, eval)(facadeRow.text)
  // Mirror the blocking Host-injected scripts before the Vite entry calls create().
  for (const id of ['@knyazevai/dsh-client-modules', '@knyazevai/dsh-client-runtime']) {
    const plugin = plugins.find(candidate => candidate.id === id)
    if (plugin === undefined) throw new Error(`missing parser-preloaded fixture row ${id}`)
    const code = bundles.get(plugin.url)
    if (code === undefined) throw new Error(`missing built bundle ${plugin.url}`)
    ;(0, eval)(code)
  }
  act(() => {
    const entry = new AppWebEntry(root, {
      loadBundle: async (url) => {
        const code = bundles.get(url)
        if (code === undefined) throw new Error(`missing built bundle ${url}`)
        ;(0, eval)(code)
      },
    })
    void entry.run()
    unmount = () => entry.dispose()
  })
}

/**
 * Match a CSS-module class by its logical name.
 * Module class names carry a per-build hash in one of two schemes —
 * ui-primitives emits `_<name>_<hash>` (name bounded by underscores),
 * feature bundles emit `<hash>_<name>` (name at the end) — and a longer name
 * containing this one must not match (`line` must not hit `lineNumber`).
 * @param el - element whose class list is inspected.
 * @param name - logical (unhashed) module class name.
 * @returns whether the element carries that module class.
 */
export function hasClass(el: Element, name: string): boolean {
  return [...el.classList].some(cls => cls === name || cls.endsWith(`_${name}`) || cls.startsWith(`_${name}_`) || cls.includes(`_${name}_`))
}

/**
 * Whether this run rewrites its golden instead of comparing against it, set by
 * the snapshot gate's `DSH_SNAPSHOT` mode (`record` re-runs the scenarios from
 * scratch, `refresh` re-derives the expected text from the existing ones).
 */
export const REFRESHING_GOLDEN = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'
