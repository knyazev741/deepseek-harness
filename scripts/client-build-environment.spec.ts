import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeClientBuildRecord } from './client-build-environment.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('complete client build record', () => {
  it('rejects a Web bundle that dropped the shell theme', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-client-build-record-'))
    roots.push(root)
    const assets = join(root, 'apps/web/dist/assets')
    mkdirSync(assets, { recursive: true })
    writeFileSync(join(root, 'apps/web/dist/index.html'), '<link rel="stylesheet" href="/assets/vendor.css">\n')
    writeFileSync(join(assets, 'vendor.css'), '.katex{font:normal 1.21em KaTeX_Main}\n')

    expect(() => writeClientBuildRecord(root, {})).toThrow('Web bundle is missing the shell theme')
  })

  it('accepts the current dynamic ui-theme client artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-client-build-record-'))
    roots.push(root)
    const assets = join(root, 'apps/web/dist/assets')
    const theme = join(root, 'packages/client/ui-theme/lib')
    mkdirSync(assets, { recursive: true })
    mkdirSync(theme, { recursive: true })
    writeFileSync(join(root, 'apps/web/dist/index.html'), '<script type="module" src="/assets/index.js"></script>\n')
    writeFileSync(join(assets, 'index.js'), 'export {}\n')
    writeFileSync(join(theme, 'client.js'), 'const css = "--dsw-font-family: sans-serif"\n')

    expect(() => writeClientBuildRecord(root, {})).not.toThrow()
  })
})
