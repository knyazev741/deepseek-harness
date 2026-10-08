import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(
  '@knyazevai/dsh-client-web',
  ['lib/types/index.js', 'lib/types/apply-injections.js'],
)
