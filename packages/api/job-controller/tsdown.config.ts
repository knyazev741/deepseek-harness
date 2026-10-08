import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@knyazevai/dsh-api-job-controller',
  ['lib/types/index.js'],
  { hostPhase: true },
)
