import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ execute: vi.fn<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>>() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: state.execute }),
}))
vi.mock('../src/system.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/system.ts')>()
  return { ...actual, resolveStartupProxy: (env: import('../src/policy.ts').EnvLookup, _platform: NodeJS.Platform, report: (message: string) => void) => actual.resolveStartupProxy(env, 'win32', report) }
})

import { installProxyFromEnvironment, proxyEnvironmentForChild, proxyRouteFor } from '../src/index.ts'
import { readWindowsProxy } from '../src/system.ts'

afterEach(() => { state.execute.mockReset() })

describe('Windows settings reader', () => {
  it('runs the built-in PowerShell reader with a deadline, hidden window, and no user profile', async () => {
    state.execute.mockResolvedValue({ stdout: JSON.stringify({ enabled: false, server: '', bypass: '', pac: '' }), stderr: '' })
    expect((await readWindowsProxy({ get: () => undefined }, 12345)).source).toBe('none')
    const [executable, args, options] = state.execute.mock.calls[0] ?? []
    expect(executable).toEqual(expect.stringContaining('powershell.exe'))
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']))
    expect(options).toMatchObject({ timeout: 12345, windowsHide: true, encoding: 'utf8' })
    if (!Array.isArray(args)) throw new Error('Expected PowerShell arguments')
    const encoded: unknown = args.at(-1)
    if (typeof encoded !== 'string') throw new Error('Expected encoded PowerShell')
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain('HKCU:')
  })

  it('redacts subprocess failures instead of exposing stderr or proxy credentials', async () => {
    state.execute.mockRejectedValue(new Error('user:private-password@private-proxy.test'))
    await expect(readWindowsProxy({ get: () => undefined }, 100)).rejects.toMatchObject({ code: 'DSH_SYSTEM_PROXY_ERROR' })
    try { await readWindowsProxy({ get: () => undefined }, 100) } catch (error) {
      expect(String(error)).not.toContain('private-password')
      expect(String(error)).not.toContain('private-proxy.test')
      expect(error).not.toHaveProperty('cause')
    }
  })

  it('routes a 256 KiB upload through the discovered system proxy and restores the environment', async () => {
    let uploadBytes = 0
    const proxy = createServer((request, response) => {
      request.on('data', (chunk: Buffer) => { uploadBytes += chunk.length })
      request.on('end', () => { response.end('SYSTEM-PROXY') })
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    const address = proxy.address() as AddressInfo
    const url = `http://127.0.0.1:${String(address.port)}`
    const before = process.env.HTTP_PROXY
    let dispose: (() => Promise<void>) | undefined
    try {
      state.execute.mockResolvedValue({ stdout: JSON.stringify({ enabled: true, server: url, bypass: '*.internal.test;<local>', pac: '' }), stderr: '' })
      const reports: string[] = []
      dispose = await installProxyFromEnvironment({ get: () => undefined }, (message) => { reports.push(message) })
      expect(proxyRouteFor(new URL('http://upload.invalid/'))).toMatchObject({ proxied: true, proxy: `${url}/` })
      expect(proxyRouteFor(new URL('http://host.internal.test/'))).toEqual({ proxied: false })
      expect(proxyRouteFor(new URL('http://127.0.0.1:3080/'))).toEqual({ proxied: false })
      expect(proxyEnvironmentForChild().NO_PROXY).toContain('<local>')
      const body = ' '.repeat(262144)
      const response = await fetch('http://upload.invalid/', { method: 'POST', body, signal: AbortSignal.timeout(10000) })
      expect(await response.text()).toBe('SYSTEM-PROXY')
      expect(uploadBytes).toBe(Buffer.byteLength(body))
      expect(reports).toHaveLength(1)
      expect(reports[0]).not.toContain(String(address.port))
    } finally {
      await dispose?.()
      await new Promise<void>((resolve, reject) => { proxy.close((error) => { if (error) reject(error); else resolve() }) })
    }
    expect(process.env.HTTP_PROXY).toBe(before)
  })
})
