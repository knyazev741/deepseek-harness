import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { WorkspaceTypertGenerator } from '../../typert/generator/lib/types/workspace.js'
import { typertPlugin } from '../../typert/generator/lib/types/tsdown-plugin.js'

const PACKAGE_NAME = '@knyazevai/dsh-fork-workspace-session-state'
const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../../..')

/** Generate this package's Host and Host-for-Client artifacts from the root Host face. */
function forkTypertPlugin() {
  const decorators = typertPlugin({ mode: 'workspace', faces: ['host'] })
  let emitted = false
  return {
    name: 'dsh-fork-workspace-session-state-typert',
    transform: decorators.transform,
    writeBundle() {
      if (emitted) return
      emitted = true
      const artifact = new WorkspaceTypertGenerator(REPOSITORY_ROOT)
        .generate([PACKAGE_NAME], ['host'])[0]
      if (artifact === undefined) throw new Error(`Typert did not model ${PACKAGE_NAME}`)
      const output = join(PACKAGE_ROOT, 'lib')
      mkdirSync(output, { recursive: true })
      writeFileSync(join(output, 'typert.host.js'), artifact.js)
      writeFileSync(join(output, 'typert.host.d.ts'), artifact.dts)
      if (artifact.remote !== undefined) {
        writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
        writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
        writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
      }
    },
  }
}

/** Build the Host service and its invariant companion as independent bundles. */
export default defineConfig(({ env }) => {
  if (env?.DSH_BUILD_FACE === 'client') return { entry: '' }
  return [
    {
      entry: ['lib/types/index.js'],
      outDir: 'lib',
      format: ['esm'],
      platform: 'node',
      target: 'es2024',
      fixedExtension: false,
      dts: false,
      clean: false,
      plugins: [forkTypertPlugin()],
    },
    {
      entry: ['lib/types/invariant.js'],
      outDir: 'lib',
      format: ['esm'],
      platform: 'node',
      target: 'es2024',
      fixedExtension: false,
      dts: false,
      clean: false,
    },
  ]
})
