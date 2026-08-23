import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectWebComposition } from './inspect.ts'
import type { WebCompositionProfile } from './types.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(profile: WebCompositionProfile = 'web'): string {
  const root = mkdtempSync(join('/tmp', 'dsh-web-composition-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head>
    <link rel="stylesheet" href="/assets/index.css">
    <script src="/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=abc"></script>
    <script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'graph',
      entries: [
        { id: '@deepseek-ai/dsh-client-modules', url: '/plugins/@deepseek-ai/dsh-client-modules/client.js', rev: 'm' },
        { id: '@deepseek-ai/dsh-client-runtime', url: '/plugins/@deepseek-ai/dsh-client-runtime/client.js', rev: 'r' },
        { id: '@deepseek-ai/dsh-client-ui-theme', url: '/plugins/@deepseek-ai/dsh-client-ui-theme/client.js', rev: 't' },
        { id: '@deepseek-ai/dsh-client-ui-conversation', url: '/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js', rev: 'c' },
        { id: '@deepseek-ai/dsh-client-ui-workspace', url: '/plugins/@deepseek-ai/dsh-client-ui-workspace/client.js', rev: 'w' },
        ...(profile === 'fork-web' ? [{ id: '@deepseek-ai/dsh-fork-ui-workspace-overlay', url: '/plugins/@deepseek-ai/dsh-fork-ui-workspace-overlay/client.js', rev: 'f' }] : []),
      ],
    })}</script>
  </head><body></body></html>`)
  writeFileSync(join(root, 'assets', 'index.css'), ':root { color: black; }')
  return root
}

describe('inspectWebComposition', () => {
  it('extracts CSS, bootstrap, theme, and sorted plugin evidence from built HTML', () => {
    const evidence = inspectWebComposition(fixture('fork-web'), 'fork-web')

    expect(evidence.cssFiles).toEqual(['assets/index.css'])
    expect(evidence.bootstrapModule).toBe('@deepseek-ai/dsh-client-modules')
    expect(evidence.themePluginId).toBe('@deepseek-ai/dsh-client-ui-theme')
    expect(evidence.pluginIds).toEqual([
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-theme',
      '@deepseek-ai/dsh-client-ui-workspace',
      '@deepseek-ai/dsh-fork-ui-workspace-overlay',
    ])
  })

  it.each([
    ['zero CSS assets', (root: string) => { rmSync(join(root, 'assets', 'index.css')) }, 'no CSS assets'],
    ['missing bootstrap', (root: string) => { writeFileSync(join(root, 'index.html'), '<html><head></head></html>') }, 'bootstrap module'],
    ['missing theme', (root: string) => {
      const path = join(root, 'index.html')
      writeFileSync(path, readFileSync(path, 'utf8').replace('"@deepseek-ai/dsh-client-ui-theme"', '"@deepseek-ai/dsh-client-ui-missing"'))
    }, 'upstream plugin id'],
  ])('rejects %s', (_name, mutate, message) => {
    const root = fixture()
    mutate(root)
    expect(() => inspectWebComposition(root, 'web')).toThrow(message)
  })

  it('rejects duplicate ids, missing upstream ids, and fork profile omissions', () => {
    const root = fixture('fork-web')
    const htmlPath = join(root, 'index.html')
    const html = readFileSync(htmlPath, 'utf8')
    writeFileSync(htmlPath, html.replace('"@deepseek-ai/dsh-fork-ui-workspace-overlay"', '"@deepseek-ai/dsh-client-ui-theme"'))
    expect(() => inspectWebComposition(root, 'fork-web')).toThrow('duplicate plugin id')

    writeFileSync(htmlPath, html.replace('"@deepseek-ai/dsh-client-ui-workspace"', '"@deepseek-ai/dsh-missing"'))
    expect(() => inspectWebComposition(root, 'fork-web')).toThrow('upstream plugin id')

    writeFileSync(htmlPath, html.replaceAll('@deepseek-ai/dsh-fork-ui-workspace-overlay', '@deepseek-ai/dsh-client-no-overlay'))
    expect(() => inspectWebComposition(root, 'fork-web')).toThrow('fork workspace overlay')
  })

  it('rejects fork ids in the upstream profile', () => {
    const root = fixture('fork-web')
    expect(() => inspectWebComposition(root, 'web')).toThrow('fork plugin id')
  })
})
