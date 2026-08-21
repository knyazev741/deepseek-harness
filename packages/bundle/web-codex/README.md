# `@deepseek-ai/dsh-web-codex`

English | [中文](README.zh.md)

The opt-in Codex Web bundle. [`cordis.patch.yml`](cordis.patch.yml) is applied after [`dsh-base`](../base/README.md) and [`dsh-web-app`](../web-app/README.md) and inserts exactly one external-session registry, permission bridge, Codex provider, external-session bridge, and authenticated loopback [`mcp-gateway`](../../mcp/mcp-gateway/README.md) row. The default `web` profile does not include this layer, so it neither starts a Codex app-server nor advertises Codex in `session.externalModes`.

The patch keeps credentials out of YAML. The provider uses the packaged `@openai/codex` launcher unless the process supplies the non-secret `DSH_CODEX_COMMAND` executable override, stores per-session `CODEX_HOME` state below `dshHomePath('external-codex')`, and validates command arguments, the absolute state root, the empty external-tool allowlist, process-disposal bounds, and the 30000-ms preflight deadline. The gateway starts with an empty allowlist and explicit 65536-byte request/response limits plus a 60000-ms execution deadline; a later local overlay may add only reviewed eligible tools and must retain valid bounds. Provider preflight checks the executable, account state, and sandbox before a mode is listed as available or a session is published; expiry aborts the wire, reaps the child tree, removes the probe state, and reports `PREFLIGHT_FAILED`.

To create a local opt-in profile, install the Web and Codex layers into a new profile (the first command initializes it with `dsh-base`), then launch it:

```sh
dsh plugin --profile codex-web add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-web-codex
dsh --profile codex-web
```

An overlay may set `external-session-codex.config.command` to a reviewed executable path and may set `allowedTools`, `preflightTimeoutMs`, or the gateway bounds; do not put API keys, bearer tokens, or other credentials in `cordis.patch.yml`. A missing dependency or a bundle named without a `dsh.bundle.patch` manifest fails loud during profile resolution.

## Model Experience

Indirectly, through the separate Codex process and the Web projection of its durable transcript; this bundle contributes no parent-Harness model prompt or native DSH model request.

#### KV Cache effect

None directly; the native DSH prefix is unchanged, while Codex owns its external conversation cache.

## Known Limitations and Deferred Work

- **The bundle is opt-in** — the shipped `web` profile remains native-only until a user adds this layer.
- **External input is text-only for now** — images, queued prompts, steering, and native goals report explicit unsupported errors; `/compact` and `/model` retain their provider-specific routes while other slash lines pass through `session.command`.
- **Browser acceptance remains Task 9** — this task covers focused service, client, and composition smoke tests; assembled browser E2E and user-visible snapshots remain deferred.
