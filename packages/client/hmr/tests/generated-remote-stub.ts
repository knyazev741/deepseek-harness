/**
 * Resolvable stand-in for the generated `./remote` contribution when this package has no built `lib/`.
 * It declares the one stream endpoint the Client face mounts, so whole-client specs exercise the real
 * `$mount` path; its item schema accepts any JSON value instead of the generated frame validation.
 */
import { createTypertRemoteInfo } from '@knyazevai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

export default createTypertRemoteInfo({
  package: '@knyazevai/dsh-client-hmr',
  methods: {
    'pluginEvents/follow': {
      service: 'pluginEvents',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@knyazevai/dsh-client-hmr/types#PluginsEventFrame',
        create: () => z.json(),
        jsonSchema: {},
      },
    },
  },
}, z)
