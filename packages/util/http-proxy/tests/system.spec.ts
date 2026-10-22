import { describe, expect, it, vi } from 'vitest'
import { bypassesSystemProxy, proxyForUrl, type EnvLookup } from '../src/policy.ts'
import { hasExplicitProxy, parseWindowsProxy, proxyStartupOptions, resolveStartupProxy } from '../src/system.ts'

function env(values: Record<string, string> = {}): EnvLookup {
  return { get: name => values[name] === undefined ? undefined : { value: values[name] } }
}

function settings(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ enabled: true, server: '127.0.0.1:7890', bypass: '', pac: '', ...overrides })
}

describe('Windows proxy settings', () => {
  it('applies one HTTP proxy to HTTP and HTTPS and preserves user exclusions', () => {
    const policy = parseWindowsProxy(settings(), env({ NO_PROXY: 'private.example' }))
    expect(policy).toMatchObject({ source: 'system', httpProxy: 'http://127.0.0.1:7890/', httpsProxy: 'http://127.0.0.1:7890/' })
    expect(proxyForUrl(policy, new URL('https://api.example/v1'))).toBe('http://127.0.0.1:7890/')
    expect(proxyForUrl(policy, new URL('https://private.example/'))).toBeUndefined()
    expect(proxyForUrl(policy, new URL('http://127.0.0.2/'))).toBeUndefined()
  })

  it('keeps unspecified protocols direct and matches Windows exclusions separately', () => {
    const policy = parseWindowsProxy(settings({ server: 'http=proxy.test:80;ftp=ftp.test:21;', bypass: '*.internal.test;<local>;192.168.*' }), env())
    expect(proxyForUrl(policy, new URL('https://outside.test/'))).toBeUndefined()
    expect(proxyForUrl(policy, new URL('http://outside.test/'))).toBe('http://proxy.test/')
    expect(proxyForUrl(policy, new URL('http://host.internal.test/'))).toBeUndefined()
    expect(proxyForUrl(policy, new URL('http://internal.test/'))).toBe('http://proxy.test/')
    expect(proxyForUrl(policy, new URL('http://printer/'))).toBeUndefined()
    expect(proxyForUrl(policy, new URL('http://192.168.1.2/'))).toBeUndefined()
  })

  it('accepts HTTPS proxies and protocol-specific servers', () => {
    const policy = parseWindowsProxy('\uFEFF' + settings({ server: 'http=http://one.test:8080;https=https://two.test:8443' }), env({ no_proxy: 'keep.test' }))
    expect(policy.httpProxy).toBe('http://one.test:8080/')
    expect(policy.httpsProxy).toBe('https://two.test:8443/')
    expect(policy.noProxy).toContain('keep.test')
  })

  it('uses an HTTPS-only server without routing HTTP through it', () => {
    const policy = parseWindowsProxy(settings({ server: 'https=proxy.test:8080' }), env())
    expect(proxyForUrl(policy, new URL('http://outside.test/'))).toBeUndefined()
    expect(proxyForUrl(policy, new URL('https://outside.test/'))).toBe('http://proxy.test:8080/')
  })

  it('is direct when the Windows manual proxy is disabled', () => {
    expect(parseWindowsProxy(settings({ enabled: false, server: '' }), env()).source).toBe('none')
  })

  it.each([
    settings({ pac: 'https://secret.example/proxy.pac' }),
    settings({ server: 'socks=proxy.test:1080' }),
    settings({ server: 'http=one.test;http=two.test' }),
    settings({ server: 'unknown=one.test' }),
    settings({ server: '=one.test' }),
    settings({ server: 'ftp=one.test:21' }),
    settings({ server: 'socks5://user:password@secret.example:1080' }),
    settings({ server: 'proxy.test/path' }),
    settings({ server: 'proxy.test?token=secret' }),
    settings({ server: 'proxy.test#secret' }),
    settings({ server: '' }),
    'not JSON containing secret.example',
    'null', '[]', '{}', settings({ enabled: 1 }), settings({ server: 1 }), settings({ bypass: null }), settings({ pac: null }),
  ])('rejects unusable settings without exposing their values', (value) => {
    expect(() => parseWindowsProxy(value, env())).toThrow()
    try { parseWindowsProxy(value, env()) } catch (error) {
      expect(String(error)).not.toContain('secret.example')
      expect(String(error)).not.toContain('password')
    }
  })
})

describe('Windows bypass matching', () => {
  it.each([
    [['<local>'], 'http://printer/', true],
    [['<local>'], 'http://printer.example/', false],
    [['*.example.test'], 'https://a.example.test/', true],
    [['*.example.test'], 'https://example.test/', false],
    [['node?.test'], 'https://node1.test/', true],
    [['https://api.test:443'], 'https://api.test/', true],
    [['https://api.test'], 'http://api.test/', false],
    [['api.test:8080'], 'http://api.test:80/', false],
    [[''], 'http://api.test/', false],
    [['api.test'], 'https://sub.api.test/', false],
  ] as const)('matches %s against %s', (entries, url, expected) => {
    expect(bypassesSystemProxy(entries, new URL(url))).toBe(expected)
  })
})

describe('startup proxy selection', () => {
  it('uses current-user Windows settings only in automatic mode with no explicit address', async () => {
    const read = vi.fn(async () => parseWindowsProxy(settings(), env()))
    const report = vi.fn()
    const result = await resolveStartupProxy(env(), 'win32', report, read)
    expect(result.policy.source).toBe('system')
    expect(read).toHaveBeenCalledWith(expect.anything(), 10000)
    expect(report.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "Using Windows system proxy. Set DSH_PROXY_MODE=direct to disable it, or configure HTTP_PROXY and HTTPS_PROXY to override it.",
        ],
      ]
    `)
    expect(report.mock.calls.flat().join()).not.toContain('7890')
  })

  it.each([
    [{ HTTPS_PROXY: 'http://explicit.test:8080' }, 'win32', 'env'],
    [{ ALL_PROXY: 'http://explicit.test:8080' }, 'win32', 'env'],
    [{ HTTPS_PROXY: 'socks5://explicit.test:1080' }, 'win32', 'none'],
    [{ DSH_PROXY_MODE: 'environment' }, 'win32', 'none'],
    [{}, 'darwin', 'none'],
    [{}, 'linux', 'none'],
  ] as const)('does not discover system settings for %s on %s', async (values, platform, source) => {
    const read = vi.fn(async () => { throw new Error('must not read Windows settings') })
    const result = await resolveStartupProxy(env(values), platform, () => {}, read)
    expect(read).not.toHaveBeenCalled()
    expect(result.policy.source).toBe(source)
  })

  it('does not fall back to direct when system proxy discovery fails', async () => {
    const read = vi.fn(async () => { throw new Error('discovery failed') })
    await expect(resolveStartupProxy(env(), 'win32', () => {}, read)).rejects.toThrow('discovery failed')
  })

  it('supports explicit direct mode and a configurable discovery deadline', async () => {
    const read = vi.fn(async () => ({ source: 'none' as const, noProxy: '' }))
    expect(await resolveStartupProxy(env({ DSH_PROXY_MODE: 'direct', HTTPS_PROXY: 'http://explicit.test' }), 'win32', () => {}, read)).toMatchObject({ forceDirect: true, policy: { source: 'none' } })
    expect(read).not.toHaveBeenCalled()
    await resolveStartupProxy(env({ DSH_SYSTEM_PROXY_TIMEOUT_MS: '12000' }), 'win32', () => {}, read)
    expect(read).toHaveBeenCalledWith(expect.anything(), 12000)
  })

  it.each(['0', '-1', '1.2', 'NaN', '60001'])('rejects invalid discovery timeout %s', (value) => {
    expect(() => proxyStartupOptions(env({ DSH_SYSTEM_PROXY_TIMEOUT_MS: value }))).toThrow('DSH_SYSTEM_PROXY_TIMEOUT_MS')
  })

  it('rejects unknown modes and distinguishes address variables from bypass entries', () => {
    expect(() => proxyStartupOptions(env({ DSH_PROXY_MODE: 'typo' }))).toThrow('DSH_PROXY_MODE')
    expect(hasExplicitProxy(env({ NO_PROXY: '*' }))).toBe(false)
    expect(hasExplicitProxy(env({ HTTPS_PROXY: '  ' }))).toBe(false)
    expect(hasExplicitProxy(env({ https_proxy: 'http://explicit.test' }))).toBe(true)
  })
})
