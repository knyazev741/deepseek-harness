/** Public contracts for the authenticated Harness-to-MCP gateway. */

import type { Context } from '@deepseek-ai/cordis'
import type { ExternalToolPrincipal } from '@deepseek-ai/dsh-tools'

/** A live gateway endpoint owned by one external-session attachment. */
export interface McpGatewayLease extends AsyncDisposable {
  /** Authenticated loopback URL containing only an opaque route id. */
  readonly url: string
  /** In-memory bearer credential; callers must pass it through an explicit env entry. */
  readonly bearerToken: string
}

/** One gateway attachment request. */
export interface McpGatewayCreateRequest {
  /** External execution identity used by the Harness tool pipeline. */
  readonly principal: ExternalToolPrincipal
  /** Requested Harness tool names; the service intersects these with its configured allowlist. */
  readonly tools: readonly string[]
  /** Attachment lifetime and cancellation signal. */
  readonly signal: AbortSignal
}

/** Service Definition consumed by external-session providers. */
export interface McpGatewayService {
  /**
   * Create one fixed, authenticated endpoint for an external principal.
   * @param request - external principal, requested tool names, and attachment signal.
   * @returns a live authenticated gateway lease.
   */
  create(request: McpGatewayCreateRequest): Promise<McpGatewayLease>
}

/** Deployment configuration for the loopback HTTP gateway. */
export interface Config {
  /** Harness tool names that may be exposed, before the definition eligibility floor. */
  readonly allowlist?: readonly string[]
  /** Maximum UTF-8 request body size, including every JSON byte. */
  readonly maxRequestBytes?: number
  /** Maximum UTF-8 size of one MCP tool result; the fixed fallback requires a minimum budget. */
  readonly maxResponseBytes?: number
  /** Maximum cooperative wall-clock duration for one tool call. */
  readonly executionTimeoutMs?: number
}

/** Cordis service name and context augmentation are kept in one declaration module. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpGateway: McpGatewayService
  }

  interface Events {
    /** A lease route became live and owned by one external attachment.
     * @mode emit
     * @param payload - route and owning session identifiers.
     */
    'mcp-gateway/lease-created'(payload: { route: string; sessionId: string }): void
    /** A lease route completed quiescent disposal.
     * @mode emit
     * @param payload - route and owning session identifiers.
     */
    'mcp-gateway/lease-disposed'(payload: { route: string; sessionId: string }): void
    /** One tool call entered the gateway's recorder/execute pair.
     * @mode emit
     * @param payload - route, call, and owning session identifiers.
     */
    'mcp-gateway/call-started'(payload: { route: string; callId: string; sessionId: string }): void
    /** One gateway call committed its durable terminal recorder result.
     * @mode emit
     * @param payload - route, call, and owning session identifiers.
     */
    'mcp-gateway/call-terminal'(payload: { route: string; callId: string; sessionId: string }): void
    /** The gateway service completed lease teardown.
     * @mode emit
     */
    'mcp-gateway/teardown-complete'(): void
  }
}

/** Keep the Context import available to declaration-merging consumers without a runtime cycle. */
export type GatewayContext = Context
