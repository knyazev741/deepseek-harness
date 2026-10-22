/**
 * Outbound HTTP proxy support for DeepSeek Harness.
 *
 * Node's built-in `fetch` ignores `HTTP_PROXY` and friends, so every harness request would connect
 * directly no matter what the user exported. The launcher resolves explicit configuration or
 * Windows manual system settings and installs undici's global dispatcher, which `fetch` resolves.
 * LLM adapters, web search, and MCP over HTTP use that dispatcher without transport-specific setup.
 *
 * This is a library, not a plugin: transport policy has one answer per process, so there is nothing
 * for a composition to mount, swap, or scope.
 *
 * Four functions, one per way a caller needs the policy — install it, ask how to send one request,
 * build a child's environment, and strip the ambient one for a replay.
 * @module @knyazevai/dsh-http-proxy
 */

export {
  clearedProxyEnv,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  type ProxyRoute,
} from './install.ts'
