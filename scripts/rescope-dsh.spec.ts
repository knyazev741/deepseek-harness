import { describe, expect, it } from 'vitest'
import { eligibleDshRescopePath, rescopeDshText } from './rescope-dsh.ts'

describe('DSH package rescope', () => {
  it('rewrites the DSH prefix without changing vendored package names or repository URLs', () => {
    expect(rescopeDshText(JSON.stringify({
      name: '@deepseek-ai/dsh-tool-bash',
      cordis: '@deepseek-ai/cordis',
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
    }))).toBe(JSON.stringify({
      name: '@knyazevai/dsh-tool-bash',
      cordis: '@deepseek-ai/cordis',
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
    }))
  })

  it('selects current tracked source and excludes historical or vendored records', () => {
    expect(eligibleDshRescopePath('packages/core/session/src/index.ts')).toBe(true)
    expect(eligibleDshRescopePath('vendor/cordis/package.json')).toBe(false)
    expect(eligibleDshRescopePath('.agents/notes/implemented/process/example.md')).toBe(false)
    expect(eligibleDshRescopePath('docs/superpowers/specs/example.md')).toBe(false)
    expect(eligibleDshRescopePath('scripts/rescope-dsh.ts')).toBe(false)
    expect(eligibleDshRescopePath('packages/core/session/lib/index.js')).toBe(false)
  })

  it('is idempotent', () => {
    const once = rescopeDshText("import '@deepseek-ai/dsh-session'")
    expect(rescopeDshText(once)).toBe(once)
  })
})
