/** Repository-local dsh launcher that selects the fork Web composition by default. */

export {}

process.env.DSH_REPOSITORY_WEB_PROFILE = 'fork-web'

const { runCli } = await import('../apps/cli/src/bin.ts')
await runCli()
