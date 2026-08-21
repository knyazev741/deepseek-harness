# Use the Web UI

English | [中文](index.zh.md)

Start the Web UI through the [root README](../../../README.md#run); the command prints its URL. This guide begins after that server is running. The `dsh` process uses its invoking directory as the default filesystem location, but a fresh Web UI has no selected workspace until you add one.

## Configure a model

Open **Settings → Models**, enter a [DeepSeek API key](https://platform.deepseek.com/), and save it. The model route becomes usable immediately without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Use the opt-in Codex mode

Install the Web and Codex bundles into a separate profile, set `DSH_CODEX_COMMAND` to an absolute Codex executable when an explicit binary is required, and launch that profile:

```sh
dsh plugin --profile codex-web add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-web-codex
DSH_CODEX_COMMAND=/absolute/path/to/codex dsh --profile codex-web
```

If preflight reports `AUTH_UNAVAILABLE`, run `codex login`, complete the ChatGPT sign-in in the browser it opens, and restart the profile. In the Web UI, choose a workspace, select **Codex** in the mode picker, then select the model and reasoning effort. Codex is listed only after its executable, account, and sandbox preflight succeeds; ambient credential variables are scrubbed, so API-key deployments must pass credentials through an explicit profile overlay.

## Choose a workspace

Click **Choose workspace**, add the project directory where you started `dsh`, and select it. The session composer remains unavailable until a workspace is selected.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/)
