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
 * Streaming callers can extend Fetch transport deadlines through the current dispatcher.
 * @module @knyazevai/dsh-http-proxy
 */

export {
  clearedProxyEnv,
  createRouteDispatcher,
  fetchWithStreamTimeout,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  type DispatcherOptions,
  type ProxyRoute,
} from './install.ts'
