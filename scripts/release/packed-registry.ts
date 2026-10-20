/** Loopback registry for entry-only installation of packed DSH releases. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { packedIdentity, packedManifest, readPublishOrder } from './tarball.ts'

/** One temporary registry, including settlement of admitted requests on close. */
export interface PackedRegistry {
  readonly url: string
  close(): Promise<void>
}

/**
 * Serve only the packed DSH versions; resolve third-party metadata from the public registry.
 * No local vendor or native tarball substitutes for a public dependency.
 * @param directory - validated DSH pack output, including its publication order.
 * @param upstream - registry origin for external package metadata.
 * @returns an OS-assigned loopback URL and its awaited cleanup.
 */
export async function startPackedRegistry(directory: string, upstream = 'https://registry.npmjs.org'): Promise<PackedRegistry> {
  const loaded = await Promise.allSettled(readPublishOrder(directory).map(async (filename) => {
    const path = join(directory, filename)
    const identity = packedIdentity(path)
    if (identity.name !== '@knyazevai/dsh' && !identity.name.startsWith('@knyazevai/dsh-')) {
      throw new Error(`Packed smoke registry only accepts DSH packages: ${identity.name}`)
    }
    const bytes = await readFile(path)
    return { ...identity, filename, path, manifest: packedManifest(path), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
  }))
  const entries = loaded.map((result) => { if (result.status === 'rejected') throw result.reason; return result.value })
  const packages = new Map(entries.map(entry => [entry.name, entry]))
  if (packages.size !== entries.length || !packages.has('@knyazevai/dsh')) throw new Error('Packed smoke registry requires one CLI and unique package names')
  const archives = new Map(entries.map(entry => [`/tarballs/${entry.filename}`, entry]))
  const cancellation = new AbortController()
  const pending = new Set<Promise<void>>()

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end()
      return
    }
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    const archive = archives.get(path)
    if (archive !== undefined) {
      response.setHeader('content-type', 'application/octet-stream')
      response.end(await readFile(archive.path, { signal: cancellation.signal }))
      return
    }
    const entry = packages.get(path.slice(1))
    if (entry !== undefined) {
      const version = { ...entry.manifest, dist: { tarball: `${url}tarballs/${entry.filename}`, integrity: entry.integrity } }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ name: entry.name, 'dist-tags': { latest: entry.version }, versions: { [entry.version]: version } }))
      return
    }
    if (path.startsWith('/@knyazevai/dsh')) {
      response.writeHead(404).end(JSON.stringify({ error: 'Package is absent from this packed release' }))
      return
    }
    const target = new URL(upstream)
    const incoming = new URL(request.url ?? '/', 'http://localhost')
    target.pathname = incoming.pathname
    target.search = incoming.search
    const remote = await fetch(target, {
      signal: cancellation.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    response.writeHead(remote.status, { 'content-type': remote.headers.get('content-type') ?? 'application/json' })
    response.end(Buffer.from(await remote.arrayBuffer()))
  }

  const server = createServer((request, response) => {
    const operation = respond(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(502)
      response.end(String(error))
    }).finally(() => { pending.delete(operation) })
    pending.add(operation)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Packed registry has no TCP address')
  const url = `http://127.0.0.1:${String(address.port)}/`
  return {
    url,
    async close() {
      cancellation.abort()
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      server.closeAllConnections()
      await Promise.allSettled([...pending])
      await closed
    },
  }
}
