/** The bundle package names the dsh installation selects, offers, installs on demand, or retires. */

/** Installation-owned defaults used when a shipped profile is first opened. */
export interface ProfileTemplate {
  /** Ordered bundle layer list. */
  bundles: readonly string[]
}

/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  'fork-web': {
    bundles: ['@knyazevai/dsh-base', '@knyazevai/dsh-web-app', '@knyazevai/dsh-fork-base', '@knyazevai/dsh-fork-web'],
  },
  'fork-headless': {
    bundles: ['@knyazevai/dsh-base', '@knyazevai/dsh-headless', '@knyazevai/dsh-fork-base'],
  },
  acp: {
    bundles: ['@knyazevai/dsh-base', '@knyazevai/dsh-acp-app'],
  },
  web: {
    bundles: ['@knyazevai/dsh-base', '@knyazevai/dsh-web-app'],
  },
  headless: {
    bundles: ['@knyazevai/dsh-base', '@knyazevai/dsh-headless'],
  },
  sdk: {
    bundles: ['@knyazevai/dsh-base', '@knyazevai/dsh-sdk-app'],
  },
  'sdk-minimal': {
    bundles: ['@knyazevai/dsh-sdk-minimal'],
  },
}

/**
 * Installation-owned bundle tuples that an earlier release wrote into a shipped profile; app-boot replaces an exact
 * match with the {@link PROFILE_TEMPLATES} entry of the same name and leaves every other list untouched.
 */
export const INSTALLATION_OWNED_PROFILE_TUPLES: Readonly<Record<string, readonly string[]>> = {
  headless: ['@knyazevai/dsh-base', '@knyazevai/dsh-web-app', '@knyazevai/dsh-headless'],
}

/** Bundles an earlier release shipped and the installation no longer carries; app-boot removes them from profiles. */
export const RETIRED_BUNDLES: ReadonlySet<string> = new Set([
  // The Web composition mounts Schedule itself
  // ([upgrade guide](../../../../docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md)).
  '@knyazevai/dsh-experimental-schedule-bundle',
  '@knyazevai/dsh-experimental-agent-team-profile',
])

/** The bundle list a `dsh plugin` init uses for a name with no shipped template. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@knyazevai/dsh-base']

/**
 * The bundles the dsh installation ships for a person to switch on: each a
 * runtime dependency of the installation that declares `dsh.bundle.patch`,
 * an `icon`, and `./locale/*.json` display metadata, selected by no shipped
 * template, and offered switched off by the plugin manager when listed
 * ([rationale](../../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md),
 * [admission](../../../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)).
 */
export const OPTIONAL_BUNDLES: readonly string[] = [
  '@knyazevai/dsh-personalized-recommendations',
  '@knyazevai/dsh-cua-bundle',
  '@knyazevai/dsh-cua-mcp',
  '@knyazevai/dsh-timeline',
  '@knyazevai/dsh-experimental-session-search',
  '@knyazevai/dsh-experimental-ralph-bundle',
  '@knyazevai/dsh-experimental-terminal-bundle',
  '@knyazevai/dsh-experimental-badge-skill-bundle',
  '@knyazevai/dsh-experimental-session-titles-bundle',
  '@knyazevai/dsh-experimental-voice-input-bundle',
  '@knyazevai/dsh-experimental-cot-translation-bundle',
  '@knyazevai/dsh-experimental-auto-review',
  '@knyazevai/dsh-experimental-inspector-profile',
  '@knyazevai/dsh-experimental-liveshare',
  '@knyazevai/dsh-experimental-plugin-market-bundle',
  '@knyazevai/dsh-experimental-tool-worktree',
  '@knyazevai/dsh-experimental-forge-bundle',
  '@knyazevai/dsh-deepseek-chat-import',
]

/** Public DSH release members available through the ordinary on-demand bundle installer. */
export const ON_DEMAND_BUNDLES: readonly string[] = [
  '@knyazevai/dsh-subagent-claude-code',
  '@knyazevai/dsh-subagent-codex',
]
