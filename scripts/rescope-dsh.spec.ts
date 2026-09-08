import { describe, expect, it } from 'vitest'
import { eligibleDshRescopePath, parseDshRescopeMode, rescopeDshText } from './rescope-dsh.ts'

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
    expect(eligibleDshRescopePath('.fork/migration/upstream-merge.md')).toBe(false)
    expect(eligibleDshRescopePath('.superpowers/sdd/2026-09-08-knyazevai-npm-scope/task-2-brief.md')).toBe(false)
    expect(eligibleDshRescopePath('docs/superpowers/specs/example.md')).toBe(false)
    expect(eligibleDshRescopePath('scripts/rescope-dsh.ts')).toBe(false)
    expect(eligibleDshRescopePath('scripts/rescope-dsh.spec.ts')).toBe(false)
    expect(eligibleDshRescopePath('scripts/rescope-vendor.ts')).toBe(false)
    expect(eligibleDshRescopePath('scripts/rescope-vendor.spec.ts')).toBe(false)
    expect(eligibleDshRescopePath('lib/index.js')).toBe(false)
    expect(eligibleDshRescopePath('dist/index.js')).toBe(false)
    expect(eligibleDshRescopePath('node_modules/pkg/index.js')).toBe(false)
    expect(eligibleDshRescopePath('packages/core/session/lib/index.js')).toBe(false)
    expect(eligibleDshRescopePath('packages/core/session/dist/index.js')).toBe(false)
    expect(eligibleDshRescopePath('packages/core/session/node_modules/pkg/index.js')).toBe(false)
  })

  it('accepts one package-runner separator before a mode', () => {
    expect(parseDshRescopeMode(['--', '--apply'])).toBe('apply')
    expect(parseDshRescopeMode(['--', '--check'])).toBe('check')
    expect(() => parseDshRescopeMode(['--', '--', '--check'])).toThrow(/unknown option/u)
  })

  it('is idempotent', () => {
    const once = rescopeDshText("import '@deepseek-ai/dsh-session'")
    expect(rescopeDshText(once)).toBe(once)
  })
})
