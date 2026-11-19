/** Experimental package identities, publication policy, and npm names. */

/**
 * Experimental packages whose npm names omit the experimental prefix, by directory. Every new experimental package
 * belongs here so that promotion keeps its name; isolation checks and plugin-record ownership recognize an unprefixed
 * experimental name only through this map.
 */
export const EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS: Readonly<Record<string, string>> = {
  'packages/experimental/cua': '@knyazevai/dsh-cua',
  'packages/experimental/cua-bundle': '@knyazevai/dsh-cua-bundle',
  'packages/experimental/cua-macos': '@knyazevai/dsh-cua-macos',
  'packages/experimental/cua-mcp': '@knyazevai/dsh-cua-mcp',
  'packages/experimental/cua-windows': '@knyazevai/dsh-cua-windows',
  'packages/experimental/timeline': '@knyazevai/dsh-timeline',
  'packages/experimental/tool-session-query': '@knyazevai/dsh-tool-session-query',
  'packages/experimental/session-title-all-prompts-llm': '@knyazevai/dsh-session-title-all-prompts-llm',
  'packages/experimental/tool-terminal': '@knyazevai/dsh-tool-terminal',
  'packages/experimental/terminal-panel': '@knyazevai/dsh-terminal-panel',
  'packages/experimental/tool-ralph': '@knyazevai/dsh-tool-ralph',
  'packages/experimental/skill-badge': '@knyazevai/dsh-skill-badge',
  'packages/experimental/hook-protocol': '@knyazevai/dsh-hook-protocol',
  'packages/experimental/hooks-claude-code': '@knyazevai/dsh-hooks-claude-code',
  'packages/experimental/hooks-codex': '@knyazevai/dsh-hooks-codex',
  'packages/experimental/webhook': '@knyazevai/dsh-webhook',
  'packages/experimental/webhook-github': '@knyazevai/dsh-webhook-github',
  'packages/experimental/action-cards': '@knyazevai/dsh-action-cards',
  'packages/experimental/client-ui-action-cards': '@knyazevai/dsh-client-ui-action-cards',
  'packages/experimental/creation-recommendations': '@knyazevai/dsh-creation-recommendations',
  'packages/experimental/client-ui-creation-recommendations': '@knyazevai/dsh-client-ui-creation-recommendations',
  'packages/experimental/plugin-recommendations': '@knyazevai/dsh-plugin-recommendations',
  'packages/experimental/client-ui-plugin-recommendations': '@knyazevai/dsh-client-ui-plugin-recommendations',
  'packages/experimental/personalized-recommendations': '@knyazevai/dsh-personalized-recommendations',
  'packages/experimental/forge-gitlab': '@knyazevai/dsh-forge-gitlab',
  'packages/experimental/deepseek-chat-import': '@knyazevai/dsh-deepseek-chat-import',
} satisfies Record<`packages/experimental/${string}`, `@knyazevai/dsh-${string}`>

/** Legacy npm namespace, allowed only in `LEGACY_PREFIXED_EXPERIMENTAL_PACKAGE_DIRECTORIES`. */
export const EXPERIMENTAL_PACKAGE_NAME_PREFIX = '@knyazevai/dsh-experimental-'

/** Existing experimental packages that keep the legacy prefix until a rename; this list must not grow. */
export const LEGACY_PREFIXED_EXPERIMENTAL_PACKAGE_DIRECTORIES: readonly string[] = [
  'packages/experimental/api-speech-to-text',
  'packages/experimental/auto-review',
  'packages/experimental/badge-skill-bundle',
  'packages/experimental/browser-use-chrome-devtools-mcp',
  'packages/experimental/browser-use-playwright-mcp',
  'packages/experimental/browser-use-runtime',
  'packages/experimental/browser-use-stagehand-native',
  'packages/experimental/claude-code-mods',
  'packages/experimental/client-ui-claude-code-mods',
  'packages/experimental/client-ui-cot-translation',
  'packages/experimental/client-ui-forge',
  'packages/experimental/client-ui-stats',
  'packages/experimental/client-ui-voice-input',
  'packages/experimental/computer-use-cua-driver-mcp',
  'packages/experimental/computer-use-cua-driver-native',
  'packages/experimental/cot-translation-bundle',
  'packages/experimental/forge',
  'packages/experimental/forge-bundle',
  'packages/experimental/forge-github',
  'packages/experimental/forge-session',
  'packages/experimental/inspector',
  'packages/experimental/inspector-profile',
  'packages/experimental/liveshare',
  'packages/experimental/liveshare-protocol',
  'packages/experimental/plugin-market-bundle',
  'packages/experimental/ralph-bundle',
  'packages/experimental/session-inspector',
  'packages/experimental/session-search',
  'packages/experimental/session-titles-bundle',
  'packages/experimental/speech-to-text',
  'packages/experimental/speech-to-text-sensevoice',
  'packages/experimental/subagent-oar',
  'packages/experimental/terminal-bundle',
  'packages/experimental/tool-subagent-oar',
  'packages/experimental/tool-worktree',
  'packages/experimental/translator',
  'packages/experimental/voice-input-bundle',
  'packages/experimental/webworker-packer',
  'packages/experimental/webworker-runtime',
  'packages/experimental/worktree',
]
const unprefixedNames = new Set(Object.values(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS))

/**
 * Identify an experimental npm package independently of its installed directory.
 * @param name - complete npm package name, without a version or subpath.
 * @returns Whether the name uses the legacy prefix or appears in `EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS`.
 */
export function isExperimentalPackageName(name: string): boolean {
  return name.startsWith(EXPERIMENTAL_PACKAGE_NAME_PREFIX) || unprefixedNames.has(name)
}

/**
 * Find experimental identities in module ids, paths, subpaths, or npm alias specifications.
 * @param reference - package reference or bundler/runtime module identifier.
 * @returns Whether a delimited package name identifies an experimental capability.
 */
export function hasExperimentalPackageReference(reference: string): boolean {
  const normalized = reference.replaceAll('\\', '/')
  return [...normalized.matchAll(/(?:^|[/:\u0000])(@knyazevai\/[^/@?#:\s]+)(?=$|[/@?#:])/g)]
    .some(([, name]) => name !== undefined && isExperimentalPackageName(name))
}

/**
 * Derive the package-owned plugin record namespace without changing persisted names.
 * @param name - complete experimental npm package name.
 * @returns Capability suffix, or undefined for a non-experimental name.
 */
export function experimentalPackageRecordNamespace(name: string): string | undefined {
  if (!isExperimentalPackageName(name)) return undefined
  return name.slice(name.startsWith(EXPERIMENTAL_PACKAGE_NAME_PREFIX) ? EXPERIMENTAL_PACKAGE_NAME_PREFIX.length : '@knyazevai/dsh-'.length)
}

/** Experimental packages excluded from public releases and npm baselines. */
export const PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES: readonly string[] = []

/**
 * Whether an experimental package publishes under the default-public policy.
 * @param directory - repository-relative package directory.
 * @param privateDirectories - experimental directories excluded from publication.
 * @returns Whether the package publishes with the dsh family.
 */
export function isPublicExperimentalPackageDirectory(
  directory: string,
  privateDirectories: readonly string[] = PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
): boolean {
  return /^packages\/experimental\/[^/]+$/.test(directory)
    && !privateDirectories.includes(directory)
}
