import { describe, expect, it, vi } from 'vitest'
import { interpolate, isJsExpr } from '@deepseek-ai/cordis-plugin-loader'

describe('fork loader expression boundary', () => {
  it('evaluates serialized own string expressions, including null-prototype YAML records', () => {
    const expression: object = Object.assign(Object.create(null) as object, { __jsExpr: 'ctx.answer' })
    expect(isJsExpr(expression)).toBe(true)
    expect(interpolate({ answer: 42 }, { nested: [expression] })).toEqual({ nested: [42] })
  })

  it('does not treat inherited, accessor, or non-string fields as executable expressions', () => {
    const getter = vi.fn(() => 'throw new Error("unexpected evaluation")')
    const accessor = Object.defineProperty({}, '__jsExpr', { get: getter })
    expect(isJsExpr(accessor)).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    expect(isJsExpr(Object.create({ __jsExpr: 'ctx.answer' }))).toBe(false)
    expect(isJsExpr({ __jsExpr: 42 })).toBe(false)
    expect(isJsExpr(null)).toBe(false)
  })
})
