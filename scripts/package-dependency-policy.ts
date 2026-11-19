/** Explicit exceptions and Host packages for the published dependency policy. */

/** Packages treated as Client/Host packages without declaring `dsh.client`. */
const CLIENT_FACE_INCLUDE: readonly string[] = []

/** Packages exempted from automatic Client/Host treatment despite declaring `dsh.client`. */
const CLIENT_FACE_EXCLUDE: readonly string[] = [
  '@knyazevai/dsh-api-session-controller',
  '@knyazevai/dsh-api-workspace-controller',
]

/** Host-only packages whose peer relays are deliberately flattened. */
const HOST_DEPENDENCY_PACKAGES: readonly string[] = [
  '@knyazevai/dsh-llm',
  '@knyazevai/dsh-session',
]

/** Required Cordis services whose Host imports are type-only. */
const REQUIRED_SERVICE_PEERS = {
  '@knyazevai/dsh-api-terminal-controller': ['@knyazevai/dsh-subprocess'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Development-only package relationships not represented by source imports. */
const CONFIGURATION_ONLY_DEV_DEPENDENCIES = {
  '@knyazevai/dsh-client-locale': ['@knyazevai/dsh-api-remotes'],
  '@knyazevai/dsh-client-ui-conversation': [
    '@knyazevai/dsh-api-remotes',
    '@knyazevai/dsh-client-ui-workspace',
  ],
  '@knyazevai/dsh-client-ui-model-selection': ['@knyazevai/dsh-client-ui-input-trigger'],
  '@knyazevai/dsh-client-ui-sidebar': ['@knyazevai/dsh-client-ui-workspace'],
  '@knyazevai/dsh-client-ui-subagent': ['@knyazevai/dsh-client-ui-input-trigger'],
  '@knyazevai/dsh-client-ui-theme': ['@knyazevai/dsh-api-remotes'],
  '@knyazevai/dsh-client-ui-tool': ['@knyazevai/dsh-api-remotes'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Workspace packages whose complete runtime surface is safe across duplicate installations. */
const DUPLICATE_SAFE_PACKAGES: readonly string[] = [
  '@knyazevai/dsh-brand',
  '@knyazevai/dsh-lazy-require',
  '@knyazevai/dsh-typert-protocol',
  '@knyazevai/dsh-util-code-language',
  '@knyazevai/dsh-util-crypto',
  '@knyazevai/dsh-util-text-search',
  '@knyazevai/dsh-util-values',
]

/**
 * Runtime exports whose values remain valid when npm installs another package copy.
 * New entries are forbidden by default. Automated agents must not add an
 * exception; every addition requires explicit human review and a dedicated,
 * prominent heading in the pull request description.
 */
const SAFE_HOST_DEPENDENCY_EXPORTS = {
  '@knyazevai/dsh-atomic-write': ['withFileLock', 'writeFileAtomic'],
  '@knyazevai/dsh-deque': ['Deque'],
  // Builds a dispatcher from the resolved proxy policy; the caller owns and closes it.
  '@knyazevai/dsh-http-proxy': ['createRouteDispatcher'],
  // The Liveshare wire codec and identity helpers are stateless functions over caller-owned values.
  '@knyazevai/dsh-experimental-liveshare-protocol': [
    'LIVESHARE_CAPABILITIES', 'LIVESHARE_PROTOCOL_VERSION', 'parseRelayFrame', 'parseShareAccessState',
    'parseTunnelWorkerCommand', 'parseTunnelWorkerEvent', 'rawText', 'sendFrame', 'unsupportedFrameRefusal',
    'viewerRequestFields', 'identityFromKey', 'identityKeyOf',
  ],
  // The shipped profile templates are plain data; a consumer reads their bundle names only.
  '@knyazevai/dsh-official-bundles': ['PROFILE_TEMPLATES'],
  // Messages and assembled blocks are plain data. Each caller owns its assembler.
  '@knyazevai/dsh-llm': ['BlockAssembler', 'callConfigEquals', 'createUserMessage'],
  '@knyazevai/dsh-session-format': ['sessionFormatLogFilename'],
  '@knyazevai/dsh-storage-domain': ['defineDomain'],
  '@knyazevai/dsh-timeout': ['MAX_TIMER_DELAY_MS'],
  // Both operate only on the caller's subprocess service and handle; the module memoizes only the binary path.
  '@knyazevai/dsh-util-ripgrep': ['readRipgrepLines', 'spawnRipgrep'],
  '@deepseek-ai/schemastery': ['default'],
} as const satisfies HostDependencyExports

/** Runtime exports that require every consumer to resolve the provider's shared peer instance. */
const PEER_REQUIRED_HOST_EXPORTS = {
  // Profile settings must match the installed Node provider's configuration schema.
  '@knyazevai/dsh-ptc-runtime-node/configuration': ['resolvePersistentExecution'],
  // CUA mounts the installed provider and shares executor error classes with PTC.
  '@knyazevai/dsh-ptc-runtime-node': ['default'],
  '@knyazevai/dsh-tool-executor-ptc/run-code': ['RunCodeConfig', 'createRunCodeTool'],
  // CUA checks UserQuestionError and preserves AttachmentError from image admission; longEdgeDimensions is pure
  // arithmetic that rides the same peer.
  '@knyazevai/dsh-attachment': ['admitEncodedImages', 'longEdgeDimensions'],
  '@knyazevai/dsh-user-questions': ['UserQuestionError'],
  // The tool registry and every subclass rely on `instanceof` against one HarnessError class.
  '@knyazevai/dsh-error': ['HarnessError'],
  // `instanceof` checks need the translator's own class instance.
  '@knyazevai/dsh-experimental-translator': ['TranslationError'],
  // Stateless; a safe classification would turn the forge panel's forge and worktree peers into dependencies.
  '@knyazevai/dsh-experimental-forge': ['changeRequestKey'],
  '@knyazevai/dsh-experimental-worktree': ['generatedWorktreeName', 'CREATED_RECORD', 'createdWorktreeSchema'],
  // The forge panel matches ctx.fs failures with `instanceof FsError`.
  '@knyazevai/dsh-fs': ['FsError'],
  '@knyazevai/dsh-scope': ['carrierKeyOf', 'createScope', 'scopeOf', 'scopeParentOf', 'scopeTarget'],
  // appendPluginRecord writes through the Session class's private log; pluginRecordOf is stateless.
  // The DeepSeek chat importer validates its seed with the installed Session class before storing it.
  '@knyazevai/dsh-session': ['SESSION_FORMAT_VERSION', 'Session', 'appendPluginRecord', 'pluginRecordOf'],
  '@knyazevai/dsh-session-persistence': ['SessionPersistenceNotFoundError'],
  // Imported titles follow the installed title service's normalization.
  '@knyazevai/dsh-session-title': ['normalizeSessionTitle'],
  // Error classes have instance identity; CUA and Liveshare throw the registry's own copy so `instanceof` against it matches.
  '@knyazevai/dsh-tools': ['defineTool', 'ToolArgsError', 'ToolContextUnavailableError'],
  // Readers recognize a deadline's TimeoutReason only by `instanceof` against their own copy.
  '@knyazevai/dsh-timeout': ['deadline', 'timeoutOf'],
  // Imported web tool results must render exactly like the installed web tools' results and cards.
  '@knyazevai/dsh-tool-web': ['fetchMetaFromValue', 'formatFetchOutput', 'formatSearchOutput', 'searchMetaFromValue'],
} as const satisfies HostDependencyExports

/** Exact import specifier to reviewed runtime exports. */
type HostDependencyExports = Readonly<Record<string, readonly string[]>>

/** Complete configurable input to package dependency classification. */
export interface PackageDependencyPolicy {
  readonly clientFaceInclude: readonly string[]
  readonly clientFaceExclude: readonly string[]
  readonly hostPackages: readonly string[]
  readonly requiredServicePeers?: Readonly<Record<string, readonly string[]>>
  readonly configurationOnlyDevDependencies: Readonly<Record<string, readonly string[]>>
  readonly duplicateSafePackages?: readonly string[]
  readonly safeHostDependencyExports: HostDependencyExports
  readonly peerRequiredHostExports: HostDependencyExports
}

/** Repository dependency policy consumed by verification and benchmarking. */
export const PACKAGE_DEPENDENCY_POLICY: PackageDependencyPolicy = {
  clientFaceInclude: CLIENT_FACE_INCLUDE,
  clientFaceExclude: CLIENT_FACE_EXCLUDE,
  hostPackages: HOST_DEPENDENCY_PACKAGES,
  requiredServicePeers: REQUIRED_SERVICE_PEERS,
  configurationOnlyDevDependencies: CONFIGURATION_ONLY_DEV_DEPENDENCIES,
  duplicateSafePackages: DUPLICATE_SAFE_PACKAGES,
  safeHostDependencyExports: SAFE_HOST_DEPENDENCY_EXPORTS,
  peerRequiredHostExports: PEER_REQUIRED_HOST_EXPORTS,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a package manifest declares a dynamically loaded Client entry. */
export function hasClientDeclaration(dshField: unknown): boolean {
  return isRecord(dshField) && Object.hasOwn(dshField, 'client')
}
