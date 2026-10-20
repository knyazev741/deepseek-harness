/** Default model references remain live without a settings service. */
import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import DefaultModel from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('reads complete selections from volatile config and clears omitted reasoning effort', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  await live.update({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  expect(consumer.currentSelection()).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
  await consumer.saveSelection({ provider: 'unsaved', model: 'unsaved' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
})

it('persists complete selections through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@knyazevai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', reasoningEffort: ReasoningEffortId('high') })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', reasoningEffort: 'high' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  const standalone = new Context()
  onTestFinished(() => standalone.fiber.dispose())
  await standalone.plugin(DefaultModel, { provider: 'test', model: 'original' })
  await standalone.agentDefaultModel.saveSelection({ provider: 'test', model: 'ignored' })
  expect(standalone.agentDefaultModel.currentSelection().model).toBe('original')
})

it('serializes overlapping saves and continues after a rejected write', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { withFileLock } = await import('@knyazevai/dsh-atomic-write')
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const editor = ctx.configEditor
  const edit = editor.edit.bind(editor)
  const calls: string[] = []
  const locked = withFileLock(join(profile.dir, 'package.json'), async () => {
    entered.resolve(undefined)
    await release.promise
  })
  let reject = true
  const intercepted = vi.spyOn(editor, 'edit').mockImplementation((entry, change) => {
    const refuse = reject
    reject = false
    return edit(entry, (current, inherited) => {
      calls.push(refuse ? 'rejected' : 'saved')
      if (refuse) throw new Error('read-only document')
      return change(current, inherited)
    })
  })
  const pending: Promise<unknown>[] = [locked]
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled(pending)
    intercepted.mockRestore()
  })
  await entered.promise
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'rejected' })
  const failed = expect(first).rejects.toThrow('read-only document')
  const drained = editor.waitForPendingEdits()
  const lastSelection = { provider: 'test', model: 'final' }
  const last = ctx.agentDefaultModel.saveSelection(lastSelection)
  pending.push(failed, last, drained)
  lastSelection.model = 'mutated'
  expect(calls).toEqual([])
  release.resolve(undefined)
  await failed
  await drained
  expect(calls).toEqual(['rejected', 'saved'])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  await last
})

it('remembers profile choices after an obsolete home-level default is removed', async () => {
  const fs = await import('node:fs')
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx, home } = await configurationFixture({ hmr: false })
  const patch = join(home, 'cordis.patch.yml')
  fs.writeFileSync(patch, JSON.stringify([
    { id: 'default-model', config: { provider: 'removed-gpu', model: 'retired-model' } },
  ]))
  await expect(ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next' }))
    .rejects.toThrow('overridden by a home patch')
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'removed-gpu', model: 'retired-model' })
  fs.writeFileSync(patch, '[]\n')
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next' })
})
