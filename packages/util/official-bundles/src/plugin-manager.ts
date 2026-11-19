/** The package names the plugin manager protects, hides, orders, or marks experimental. */

/**
 * Plugin packages the plugin manager refuses to disable or remove, because management itself needs them; a bundle that
 * contains one is read-only as well. Removing a name drops only this `management-required` refusal; the manager's own
 * entry, installation-carried bundles, and unaddressable rows stay protected by their own rules.
 */
export const PROTECTED_PLUGINS: ReadonlySet<string> = new Set([
  '@knyazevai/dsh-plugin-manager', '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include', '@knyazevai/dsh-api-gateway',
  '@knyazevai/dsh-host-webserver', '@knyazevai/dsh-client-modules',
  '@knyazevai/dsh-client-ui-plugin-manager',
  '@knyazevai/dsh-host-plugin-inventory', '@knyazevai/dsh-typert-registry',
  '@knyazevai/dsh-api-remotes', '@knyazevai/dsh-api-remote-access',
  '@deepseek-ai/cordis-plugin-timer', '@knyazevai/dsh-client-connection',
  '@knyazevai/dsh-host-frontend-static', '@knyazevai/dsh-tools',
  '@knyazevai/dsh-hmr',
])

/**
 * Built-in profile bundles, the standalone worktree tool, and the Computer Use MCP profile
 * bundle, which have no plugin manager page.
 * Their Host availability and activation stay intact.
 */
export const HIDDEN_BUNDLES: ReadonlySet<string> = new Set([
  '@knyazevai/dsh-base',
  '@knyazevai/dsh-web-app',
  '@knyazevai/dsh-headless',
  '@knyazevai/dsh-sdk-app',
  '@knyazevai/dsh-acp-app',
  '@knyazevai/dsh-sdk-minimal',
  '@knyazevai/dsh-experimental-tool-worktree',
  '@knyazevai/dsh-cua-mcp',
])

/**
 * The optional bundles the plugin manager's main and More lists rank first, in this order. {@link MORE_BUNDLES}, not
 * this list, decides whether a bundle appears on the main list.
 */
export const EXTENSION_BUNDLES: readonly string[] = [
  '@knyazevai/dsh-experimental-voice-input-bundle',
  '@knyazevai/dsh-experimental-plugin-market-bundle',
  '@knyazevai/dsh-experimental-auto-review',
]

/**
 * The optional bundles the plugin manager's main list leaves out until the profile enables them; its More list,
 * which includes every eligible bundle, ranks them last in this order.
 */
export const MORE_BUNDLES: readonly string[] = [
  '@knyazevai/dsh-personalized-recommendations',
  '@knyazevai/dsh-experimental-inspector-profile',
  '@knyazevai/dsh-cua-bundle',
  '@knyazevai/dsh-timeline',
  '@knyazevai/dsh-experimental-terminal-bundle',
  '@knyazevai/dsh-experimental-cot-translation-bundle',
  '@knyazevai/dsh-experimental-session-search',
  '@knyazevai/dsh-experimental-session-titles-bundle',
  '@knyazevai/dsh-experimental-badge-skill-bundle',
  '@knyazevai/dsh-experimental-ralph-bundle',
  '@knyazevai/dsh-deepseek-chat-import',
  '@knyazevai/dsh-subagent-codex',
  '@knyazevai/dsh-subagent-claude-code',
]

/** Official bundles the plugin manager marks with the Experimental badge. */
export const EXPERIMENTAL_BUNDLES: ReadonlySet<string> = new Set([
  '@knyazevai/dsh-personalized-recommendations',
  '@knyazevai/dsh-cua-bundle',
  '@knyazevai/dsh-cua-mcp',
  '@knyazevai/dsh-timeline',
  '@knyazevai/dsh-experimental-terminal-bundle',
  '@knyazevai/dsh-experimental-voice-input-bundle',
  '@knyazevai/dsh-experimental-auto-review',
  '@knyazevai/dsh-experimental-inspector-profile',
  '@knyazevai/dsh-experimental-forge-bundle',
  '@knyazevai/dsh-experimental-tool-worktree',
  '@knyazevai/dsh-experimental-cot-translation-bundle',
  '@knyazevai/dsh-experimental-session-search',
  '@knyazevai/dsh-experimental-session-titles-bundle',
  '@knyazevai/dsh-experimental-badge-skill-bundle',
  '@knyazevai/dsh-experimental-ralph-bundle',
  '@knyazevai/dsh-experimental-plugin-market-bundle',
  '@knyazevai/dsh-experimental-liveshare',
  '@knyazevai/dsh-deepseek-chat-import',
])
