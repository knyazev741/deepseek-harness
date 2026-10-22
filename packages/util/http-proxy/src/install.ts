/**
 * Proxy installation: the transport half of this package. It owns undici's global dispatcher and the
 * process-wide record of which policy is active.
 *
 * `undici` is imported dynamically so the pure {@link ProxyPolicy} half stays loadable where no Node
 * transport exists, matching how `dsh-web-fetch-http` defers its own transport import.
 * @module @knyazevai/dsh-http-proxy/install
 */

import type { Dispatcher, Pool } from 'undici'
import {
  isSupportedProxyUrl,
  POLICY_ENV_NAMES,
  PROXY_ENV_NAMES,
  proxyForUrl,
  type EnvLookup,
  type ProxyPolicy,
} from './policy.ts'
import { resolveStartupProxy } from './system.ts'


/** The active policy, or `undefined` until one is installed. Process-wide, like the dispatcher it tracks. */
let active: ProxyPolicy | undefined

/**
 * The proxy environment as the user exported it, or `undefined` when no policy is installed.
 *
 * Owned by the OUTERMOST install: one layered over the launcher's would otherwise record the outer
 * policy's published values as if the user had written them, and
 * hand every child a normalization the user never asked for.
 *
 * {@link proxyEnvironmentForChild} keeps a value the user set rather than the one this process resolved from
 * it, so a SOCKS proxy `curl` can use is not replaced by an HTTP proxy named for another scheme.
 */
let inheritedProxyEnv: Readonly<Record<string, string | undefined>> | undefined

/** The dispatcher installed with {@link active}, so a route can hand back the one already routing. */
let installed: Dispatcher | undefined

/**
 * How this process must send one request.
 *
 * A caller that branches on the answer needs the transport that answer assumed, or an install or
 * disposal landing between the two would send the request somewhere the branch did not clear. The
 * proxied arm therefore carries the dispatcher already routing by this policy: it is process-wide
 * and long-lived, so a caller uses it and never closes it. Disposal closes that dispatcher rather
 * than destroying it, so a request already dispatched when a policy is unmounted still finishes.
 */
export type ProxyRoute =
  | { readonly proxied: true; readonly proxy: string; readonly dispatcher: Dispatcher }
  | { readonly proxied: false }

/** A route that sends nothing through a proxy, shared because it carries no per-request state. */
const DIRECT_ROUTE: ProxyRoute = { proxied: false }

/**
 * Decide how to send one request, and hand back the transport that decision assumed.
 *
 * @param url - the request URL.
 * @returns the proxied route with its proxy URL and dispatcher, or the direct route.
 */
export function proxyRouteFor(url: URL): ProxyRoute {
  const policy = active
  const dispatcher = installed
  if (policy === undefined || dispatcher === undefined) return DIRECT_ROUTE
  const proxy = proxyForUrl(policy, url)
  return proxy === undefined ? DIRECT_ROUTE : { proxied: true, proxy, dispatcher }
}

/**
 * Publish a policy through the proxy environment variables, which is how the consumers that read an
 * environment rather than a policy object — `node:http`'s `proxyEnv` and every spawned child — see
 * the one resolved answer, including the `ALL_PROXY` fallback and the merged loopback bypass that
 * neither derives on its own. The global dispatcher does not read these; it routes by the policy.
 *
 * @param policy - the policy to publish.
 * @returns a function restoring every name this call changed.
 */
function applyPolicyEnv(policy: ProxyPolicy): () => void {
  const previousInherited = inheritedProxyEnv
  inheritedProxyEnv = previousInherited ?? snapshotProxyEnv()
  const published: Record<string, string | undefined> = {}
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const value = publishedPolicyValue(policy, field as keyof typeof POLICY_ENV_NAMES)
    for (const name of names) published[name] = value
  }
  const restore = writeProxyEnv(published)
  return () => {
    restore()
    inheritedProxyEnv = previousInherited
  }
}

/**
 * Read every proxy name this package publishes, as `process.env` holds it now.
 *
 * @returns one entry per name in {@link POLICY_ENV_NAMES}; `undefined` marks an absent name.
 */
function snapshotProxyEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const names of Object.values(POLICY_ENV_NAMES)) {
    for (const name of names) snapshot[name] = process.env[name]
  }
  return snapshot
}

/** Environment readers receive Windows exclusions in NO_PROXY; their wildcard rules remain transport-owned. */
function publishedPolicyValue(policy: ProxyPolicy, field: keyof typeof POLICY_ENV_NAMES): string | undefined {
  if (field !== 'noProxy') return policy[field]
  return [policy.noProxy, ...policy.systemBypass ?? []].filter(Boolean).join(',')
}

/**
 * Set every proxy name to the value `values` holds for it, removing a name whose value is `undefined`.
 *
 * @param values - the value each name in {@link POLICY_ENV_NAMES} should hold.
 * @returns a function restoring every name to what it held before this call.
 */
function writeProxyEnv(values: Readonly<Record<string, string | undefined>>): () => void {
  // Snapshot EVERY name before writing any of them. Windows folds environment names case-insensitively,
  // so reading the uppercase spelling after writing the lowercase one would read back the value just
  // written and restore the policy instead of the user's environment.
  const previous = snapshotProxyEnv()
  for (const name of Object.keys(previous)) {
    const value = values[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

/**
 * Build the global dispatcher for one policy.
 *
 * Routing runs through {@link proxyForUrl} per origin, so `fetch` and every caller that asks where a
 * URL goes read the same answer from the same matcher. undici's `EnvHttpProxyAgent` cannot express
 * this policy: with no `HTTPS_PROXY` present it reuses the HTTP proxy for `https:`, which would
 * tunnel a scheme this package deliberately keeps direct after refusing the SOCKS or malformed URL
 * the user named for it — the route and the diagnostic would then disagree.
 *
 * @param policy - the policy to route by; it must proxy at least one scheme.
 * @returns the dispatcher to install, owning every per-origin agent its factory created.
 */
async function createPolicyDispatcher(policy: ProxyPolicy): Promise<Dispatcher> {
  const { Agent, Pool, ProxyAgent } = await import('undici')
  return new Agent({
    factory(origin, options) {
      // undici declares this parameter as `Object`, discarding the pool options it actually passes.
      const passed = options as Pool.Options
      const proxy = proxyForUrl(policy, new URL(origin.toString()))
      if (proxy !== undefined) return new ProxyAgent({ ...passed, uri: proxy })
      // What undici's own default factory builds for these options, which `factory` replaces
      // wholesale. It reaches for a bare `Client` only at `connections: 1`, an option this
      // dispatcher never carries: it is constructed with undici's defaults.
      return new Pool(origin, passed)
    },
  })
}

/**
 * Route this process's outbound HTTP through `policy`.
 *
 * Installing replaces undici's global dispatcher, which is what Node's built-in `fetch` resolves, so
 * every caller that issues a plain `fetch()` is covered without knowing this package exists. A policy
 * that proxies nothing preserves ambient settings unless direct routing was explicitly requested.
 *
 * A worker thread has its own `globalThis` and so its own dispatcher; installing here does not
 * reach it. No worker installs one today: both this repository ships — the workflow engine and the
 * PTC runtime — evaluate model-authored scripts, which must not receive a proxy URL that may carry
 * credentials. A worker that needs the policy has to be handed one explicitly and install it itself.
 *
 * @param policy - the resolved policy to install.
 * @param forceDirect - replace the ambient dispatcher and clear proxy variables for explicit direct mode.
 * @returns a disposer restoring the previous dispatcher, policy, and environment, then closing the agent.
 */
async function installGlobalProxy(policy: ProxyPolicy, forceDirect = false): Promise<() => Promise<void>> {
  const previousPolicy = active
  if (policy.source === 'none') {
    // A direct policy mounted over an installed one must actually stop proxying. Recording the policy
    // alone would leave the previous agent as the global dispatcher, so a plain `fetch()` would keep
    // tunnelling while `proxyForUrl()` reported a direct connection — and `mode: 'off'` would be a
    // silent no-op. With nothing installed there is nothing to displace.
    if (previousPolicy === undefined && !forceDirect) {
      active = policy
      return () => {
        active = previousPolicy
        return Promise.resolve()
      }
    }
    const previousInstalled = installed
    // The install underneath published its normalized policy into `process.env`, which is what a
    // spawned child copies. With no policy active there is no normalization to stand behind, so the
    // user's own values return for the window and the outer install's come back when it ends. An
    // install underneath that proxied nothing published nothing, and there is nothing to put back.
    const undici = await import('undici')
    const previous = undici.getGlobalDispatcher()
    const direct = new undici.Agent()
    const restoreEnv = forceDirect ? clearProcessProxyEnv() : inheritedProxyEnv === undefined ? undefined : writeProxyEnv(inheritedProxyEnv)
    undici.setGlobalDispatcher(direct)
    active = policy
    installed = forceDirect ? direct : undefined
    return async () => {
      undici.setGlobalDispatcher(previous)
      active = previousPolicy
      installed = previousInstalled
      restoreEnv?.()
      await direct.close()
    }
  }
  const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const previousDispatcher = getGlobalDispatcher()
  const previousInstalled = installed
  const agent = await createPolicyDispatcher(policy)
  const restoreEnv = applyPolicyEnv(policy)
  setGlobalDispatcher(agent)
  active = policy
  installed = agent
  return async () => {
    setGlobalDispatcher(previousDispatcher)
    active = previousPolicy
    installed = previousInstalled
    restoreEnv()
    await agent.close()
  }
}

/** Clear an explicitly disabled proxy for this process and its children, restoring every spelling on disposal. */
function clearProcessProxyEnv(): () => void {
  const previous = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
  for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}




/**
 * The proxy environment a spawned child needs.
 *
 * A child inherits the parent environment, which this process rewrote to its own resolved policy.
 * Handing that normalization straight through would replace values the user set for other tools, so
 * each proxy name the user exported is restored to what they wrote: a SOCKS proxy `curl` uses is
 * not swapped for the HTTP one this package fell back to for that scheme.
 *
 * A scheme the user named in neither casing carries the resolved value instead of being removed.
 * Without that the child's routing silently diverges from its parent's: `NODE_USE_ENV_PROXY` does
 * not read `ALL_PROXY`, so a child of a parent that resolved its proxy from that name would connect
 * directly while the parent proxies.
 *
 * The bypass list is always the resolved one. It only ever adds the loopback entries to what
 * the user wrote, so nothing is lost, and the child stops sending its own localhost traffic to a
 * proxy that cannot route it.
 *
 * The flag reaches only Node 22.21+ and 24+; an older runtime keeps that child direct. Such a child
 * also matches bypass entries with Node's own `NO_PROXY` rules, which differ from this package's in
 * their separators and IPv4-range support. Non-Node children (curl, git, pnpm) ignore the flag and
 * read the variables themselves.
 *
 * The flag is withheld when a proxy value the child receives is one this package refused. Node
 * parses `HTTP_PROXY` and `HTTPS_PROXY` under that flag before running the program, and exits on a
 * scheme other than `http:` or `https:` — so a SOCKS value kept for `curl` would stop every Node
 * child from starting. Without the flag such a child connects directly, as this process already
 * reported for that scheme, and `curl` still reads the value it was kept for.
 *
 * A worker thread is deliberately NOT served here — see the workflow engine, which runs
 * model-authored scripts and must not receive a proxy URL that may carry credentials.
 *
 * @returns names to apply to the child environment, where `undefined` means remove; explicit direct
 *   mode removes proxy addresses, while an inactive policy returns an empty object.
 */
export function proxyEnvironmentForChild(): Readonly<Record<string, string | undefined>> {
  const policy = active
  const inherited = inheritedProxyEnv
  if (policy?.source === 'none' && installed !== undefined) return { ...clearedProxyEnv(), NODE_USE_ENV_PROXY: undefined }
  if (policy === undefined || policy.source === 'none' || inherited === undefined) return {}
  const overlay: Record<string, string | undefined> = { NODE_USE_ENV_PROXY: '1' }
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const resolved = publishedPolicyValue(policy, field as keyof typeof POLICY_ENV_NAMES)
    // Naming a scheme in either casing claims that scheme: the child then gets exactly what the
    // user wrote, in the casing they wrote it, rather than a value derived for this process.
    const named = field !== 'noProxy' && names.some(name => inherited[name] !== undefined)
    for (const name of names) overlay[name] = named ? inherited[name] : resolved
  }
  const parsedByNode = [...POLICY_ENV_NAMES.httpProxy, ...POLICY_ENV_NAMES.httpsProxy]
  if (parsedByNode.some(name => overlay[name] !== undefined && !isSupportedProxyUrl(overlay[name]))) {
    delete overlay.NODE_USE_ENV_PROXY
  }
  return overlay
}

/**
 * Resolve explicit proxy configuration or Windows manual system settings and install the policy.
 *
 * Resolution, reporting, and installation are one operation because no caller needs them apart: the
 * launcher does all three in sequence before the first plugin mounts, and a policy resolved but not
 * installed routes nothing.
 *
 * A value the environment supplies but this package cannot use is reported and skipped rather than
 * thrown: the variable may have been exported for another tool, and a proxy the harness cannot use
 * must not stop the agent from starting. Automatic Windows discovery failures stop startup with
 * an actionable, address-free error; direct mode explicitly clears proxy variables and dispatchers.
 *
 * @param env - the launch environment, whose own layering already prefers real variables over `.env` files.
 * @param report - receives address-free discovery and rejected-value diagnostics.
 * @returns a disposer restoring the previous dispatcher, policy, and environment.
 */
export async function installProxyFromEnvironment(
  env: EnvLookup,
  report: (message: string) => void,
): Promise<() => Promise<void>> {
  const selected = await resolveStartupProxy(env, process.platform, report)
  return await installGlobalProxy(selected.policy, selected.forceDirect)
}

/**
 * The environment overlay that removes every proxy name from a spawned child.
 *
 * A harness that replays a recorded session must reach its own fixture server, not the proxy a
 * developer or a CI runner exported; `undefined` is how a spawn removes a name it inherits.
 *
 * @returns removed address variables and environment-only mode, disabling Windows discovery for isolated children.
 */
export function clearedProxyEnv(): Record<string, string | undefined> {
  return { ...Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, undefined])), DSH_PROXY_MODE: 'environment' }
}
