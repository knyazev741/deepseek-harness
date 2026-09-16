import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@knyazevai/dsh-api-workspace-files',
  ['lib/types/index.js'],
  { hostPhase: true },
)
