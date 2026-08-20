# @deepseek-ai/dsh-mcp-gateway

English | [中文](README.zh.md)

Authenticated loopback Streamable HTTP gateway for exposing a fixed, explicitly allowlisted set of Harness tools to one external session such as Codex.

## Usage

Mount the gateway beside the local Web server and tools runtime:

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 0
- name: '@deepseek-ai/dsh-mcp-gateway'
  config:
    allowlist: [read_file, shell_foreground]
```

The service requires the Web server to bind to `127.0.0.1`. An external-session consumer calls `ctx.mcpGateway.create({ principal, tools, signal })` and receives an `McpGatewayLease` with an opaque URL and an in-memory bearer token.

## Security and policy

Authentication is checked before method validation, body parsing, MCP dispatch, or tool lookup. Each lease gets a random route and bearer credential; neither the route URL nor diagnostics contain a session id or token. The configured allowlist is intersected with the requested names and the Task 5 definition-level `externalEligibility: 'allow'` opt-in, so omitted eligibility remains default-deny.

Every call reaches `ctx.tools.execute` with the supplied `ExternalToolPrincipal`. The gateway never calls a definition directly, creates a native Agent, opens a native turn, or uses scheduler internals. Guards, approval, validation, rendering, result observers, and the external recorder therefore remain in the normal pipeline. The recorder receives one call commit before dispatch and one matching result or error commit after dispatch.

Requests accept only `GET`, `POST`, and `DELETE` at the stateful MCP endpoint. JSON POST bodies require `application/json`, strict UTF-8 decoding, one JSON value with no trailing bytes, and the configured byte/time limits. Unknown routes, sessions, methods, and tool names fail closed.

## Configuration

| Field | Default | Description |
|---|---:|---|
| `allowlist` | `[]` | Fixed tool names eligible for external exposure; each definition must also opt in with `externalEligibility: 'allow'`. |
| `maxRequestBytes` | `65536` | Maximum UTF-8 bytes in one JSON request body. |
| `executionTimeoutMs` | `60000` | Body-read and cooperative tool-call deadline. Lease disposal aborts the same signal. |

## Lifecycle

The lease disposer removes the route, aborts in-flight calls, waits for request handlers, and closes stateful MCP transports. The external Codex provider awaits this disposer before tearing down its child process. A resumed attachment writes a fresh endpoint and token to the private Codex home while retaining the existing rollout files.

The token is passed to Codex only through the explicit environment variable named by `bearer_token_env_var`; it is never written to `config.toml`, the URL, argv, session events, logs, or snapshots. This package does not configure client routing or a Web opt-in bundle; those belong to later tasks.

## Services

| Service | Usage |
|---|---|
| `ctx.webServer` | Registers one exact loopback route per live lease. |
| `ctx.tools` | Snapshots schemas and dispatches calls through the external-principal pipeline. |
| `ctx.approval` | Optional pipeline consumer for explicit external approval requests. |
| `ctx.externalSessions` | Owns the principal recorder and attachment lifetime through the external-session consumer. |

## Model Experience

### External tool catalog and calls

#### What the model sees

Codex sees only the configured allowlisted tool schemas returned by `tools/list`. A successful call returns Harness-rendered text and object-valued structured content; a failed call returns MCP `isError` content. The parent Harness model sees none of the external gateway's calls as native turns.

#### Token effect

Codex pays for the advertised schemas, arguments, and mapped result content in its own context. The bearer credential and route are transport credentials, not model-visible content.

#### KV Cache effect

The advertised schema prefix remains reusable while the fixed set and definitions stay unchanged. A new attachment rotates only the opaque transport endpoint and credential; it does not add durable model context.

## Known Limitations and Deferred Work

- Resources, prompts, SSE fan-out, and non-loopback hosting are not exposed; the gateway is intentionally a single-attachment loopback tools endpoint.
- The timeout is cooperative: tool implementations must observe the execution signal and settle their owned work before disposal can complete.
- Web opt-in bundles and client-side Codex routing are owned by later tasks and are not part of this package.
