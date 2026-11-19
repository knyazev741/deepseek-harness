/** A real extra registration used to detect one-sided profile additions. */
import { defineTool } from '@knyazevai/dsh-tools'

export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'parity_probe', description: 'Test profile addition.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'probe' },
  }))
}
