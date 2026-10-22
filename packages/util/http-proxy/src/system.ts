/** Windows manual proxy discovery before the launcher mounts network consumers. */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DIRECT_POLICY, PROXY_ENV_NAMES, resolveProxyPolicy, withLoopback, type EnvLookup, type ProxyPolicy } from './policy.ts'

const execute = promisify(execFile)
const WINDOWS_SETTINGS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$p = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
@{ enabled = ($p.ProxyEnable -eq 1); server = [string]$p.ProxyServer; bypass = [string]$p.ProxyOverride; pac = [string]$p.AutoConfigURL } | ConvertTo-Json -Compress
`

/** A proxy discovery failure with no addresses, credentials, or PowerShell output in its message. */
export class SystemProxyError extends Error {
  /** Stable failure category for startup reporting. */
  readonly code = 'DSH_SYSTEM_PROXY_ERROR'
}

/** Validated proxy selection for one process launch. */
export interface ProxyStartupOptions {
  /** Auto uses Windows settings only when no proxy was explicitly configured. */
  readonly mode: 'auto' | 'environment' | 'direct'
  /** Maximum time allowed for the Windows settings reader, in milliseconds. */
  readonly timeoutMs: number
}

/**
 * Read proxy launch controls from the same layered environment as proxy addresses.
 * @param env - exported variables and user-level .env values.
 * @returns validated mode and discovery timeout; invalid values fail before transport changes.
 */
export function proxyStartupOptions(env: EnvLookup): ProxyStartupOptions {
  const mode = env.get('DSH_PROXY_MODE')?.value.trim() || 'auto'
  if (mode !== 'auto' && mode !== 'environment' && mode !== 'direct') {
    throw new SystemProxyError('DSH_PROXY_MODE must be auto, environment, or direct')
  }
  const raw = env.get('DSH_SYSTEM_PROXY_TIMEOUT_MS')?.value.trim() || '10000'
  const timeoutMs = Number(raw)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new SystemProxyError('DSH_SYSTEM_PROXY_TIMEOUT_MS must be an integer from 1 to 60000')
  }
  return { mode, timeoutMs }
}

/**
 * Whether a user supplied an address, including an unsupported one that must not select another route.
 * @param env - layered launch environment.
 * @returns true when any HTTP, HTTPS, or ALL proxy variable is nonempty.
 */
export function hasExplicitProxy(env: EnvLookup): boolean {
  return PROXY_ENV_NAMES.some(name => !/no_proxy/iu.test(name) && (env.get(name)?.value.trim() ?? '') !== '')
}

/**
 * Select the startup route before any dispatcher or process environment is changed.
 * @param env - layered user configuration.
 * @param platform - platform of the process owning the network transport.
 * @param report - receives address-free startup diagnostics.
 * @param readSystem - platform I/O adapter, completed before transport installation.
 * @returns the resolved policy and whether an explicit direct mode must replace an ambient dispatcher.
 */
export async function resolveStartupProxy(
  env: EnvLookup,
  platform: NodeJS.Platform,
  report: (message: string) => void,
  readSystem: (env: EnvLookup, timeoutMs: number) => Promise<ProxyPolicy> = readWindowsProxy,
): Promise<{ policy: ProxyPolicy; forceDirect: boolean }> {
  const options = proxyStartupOptions(env)
  if (options.mode === 'direct') return { policy: DIRECT_POLICY, forceDirect: true }
  if (options.mode === 'auto' && platform === 'win32' && !hasExplicitProxy(env)) {
    const policy = await readSystem(env, options.timeoutMs)
    if (policy.source === 'system') report('Using Windows system proxy. Set DSH_PROXY_MODE=direct to disable it, or configure HTTP_PROXY and HTTPS_PROXY to override it.')
    return { policy, forceDirect: false }
  }
  const { policy, diagnostics } = resolveProxyPolicy(env)
  for (const diagnostic of diagnostics) report(diagnostic.message)
  return { policy, forceDirect: false }
}

function proxyUrl(value: string): string {
  const candidate = value.includes('://') ? value : `http://${value}`
  const parsed = URL.parse(candidate)
  if (parsed === null || !['http:', 'https:'].includes(parsed.protocol) || parsed.hostname === ''
    || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new SystemProxyError('Windows has an unsupported proxy address; set HTTP_PROXY and HTTPS_PROXY to HTTP(S) proxy URLs, or set DSH_PROXY_MODE=direct')
  }
  return parsed.href
}

/**
 * Validate the PowerShell result and retain protocol-specific Windows proxy and exclusion rules.
 * @param output - JSON emitted by the Windows settings reader.
 * @param env - environment supplying optional additional NO_PROXY exclusions.
 * @returns a manual system proxy policy, or the unchanged direct policy when disabled.
 * @throws SystemProxyError for unreadable settings, PAC scripts, or unsupported addresses.
 */
export function parseWindowsProxy(output: string, env: EnvLookup): ProxyPolicy {
  let data: unknown
  try { data = JSON.parse(output.replace(/^\uFEFF/u, '').trim()) } catch (_error) {
    // PowerShell diagnostics can contain local settings; expose only the actionable category.
    throw new SystemProxyError('Cannot read Windows proxy settings; configure HTTP_PROXY and HTTPS_PROXY, or set DSH_PROXY_MODE=direct')
  }
  if (data === null || typeof data !== 'object' || !('enabled' in data) || typeof data.enabled !== 'boolean'
    || !('server' in data) || typeof data.server !== 'string' || !('bypass' in data) || typeof data.bypass !== 'string'
    || !('pac' in data) || typeof data.pac !== 'string') {
    throw new SystemProxyError('Windows returned invalid proxy settings; configure HTTP_PROXY and HTTPS_PROXY, or set DSH_PROXY_MODE=direct')
  }
  if (data.pac.trim() !== '') {
    throw new SystemProxyError('Windows uses an automatic proxy script (PAC); set HTTP_PROXY and HTTPS_PROXY to its HTTP proxy address, or set DSH_PROXY_MODE=direct')
  }
  if (!data.enabled) return DIRECT_POLICY
  const slots = new Map<string, string>()
  const server = data.server.trim()
  if (!server.includes('=')) {
    slots.set('http', proxyUrl(server))
    slots.set('https', proxyUrl(server))
  } else {
    for (const entry of server.split(';')) {
      if (entry.trim() === '') continue
      const split = entry.indexOf('=')
      const scheme = entry.slice(0, split).trim().toLowerCase()
      if (split < 1 || !['http', 'https', 'ftp', 'socks'].includes(scheme)) {
        throw new SystemProxyError('Windows has invalid protocol proxy settings; configure HTTP_PROXY and HTTPS_PROXY, or set DSH_PROXY_MODE=direct')
      }
      if (scheme === 'socks') throw new SystemProxyError('Windows uses a SOCKS proxy; configure an HTTP(S) proxy with HTTP_PROXY and HTTPS_PROXY, or set DSH_PROXY_MODE=direct')
      if (scheme === 'http' || scheme === 'https') {
        if (slots.has(scheme)) throw new SystemProxyError('Windows has duplicate protocol proxy settings; configure HTTP_PROXY and HTTPS_PROXY, or set DSH_PROXY_MODE=direct')
        slots.set(scheme, proxyUrl(entry.slice(split + 1).trim()))
      }
    }
  }
  if (slots.size === 0) throw new SystemProxyError('Windows has no supported HTTP proxy; configure HTTP_PROXY and HTTPS_PROXY, or set DSH_PROXY_MODE=direct')
  const noProxy = env.get('no_proxy')?.value.trim() || env.get('NO_PROXY')?.value.trim() || ''
  const httpProxy = slots.get('http'), httpsProxy = slots.get('https')
  return {
    source: 'system', noProxy: withLoopback(noProxy),
    ...httpProxy === undefined ? {} : { httpProxy },
    ...httpsProxy === undefined ? {} : { httpsProxy },
    systemBypass: data.bypass.split(';').map(entry => entry.trim()).filter(Boolean),
  }
}

/**
 * Query current-user Windows Internet Settings without printing addresses or loading a PowerShell profile.
 * @param env - launch environment supplying optional additional NO_PROXY exclusions.
 * @param timeoutMs - validated subprocess deadline.
 * @returns the current manual proxy policy; the subprocess has exited before resolution.
 */
export async function readWindowsProxy(env: EnvLookup, timeoutMs: number): Promise<ProxyPolicy> {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  let output: string
  try {
    const result = await execute(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SETTINGS, 'utf16le').toString('base64'),
    ], { windowsHide: true, timeout: timeoutMs, maxBuffer: 65536, encoding: 'utf8' })
    output = result.stdout
  } catch (_error) {
    // Child output and command errors may include proxy credentials; do not propagate them.
    throw new SystemProxyError('Cannot read Windows proxy settings; configure HTTP_PROXY and HTTPS_PROXY, or set DSH_PROXY_MODE=direct')
  }
  return parseWindowsProxy(output, env)
}
