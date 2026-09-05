# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install Node.js 22.19+ or 24+, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/knyazev741/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh plugin --profile fork-web add -w @knyazevai/dsh@0.1.4
pnpm dsh web
```

In this repository checkout, `pnpm dsh web` starts the complete `fork-web`
composition. The `@knyazevai/dsh` plugin aligns its provider, model, subagent,
and compaction policy with the Knyazev AI deployment. Together they include a
400k context window for DeepSeek V4 Flash, bounded compaction, transient-error
retries, and long-cooldown recovery. Set `KNYAZEV_AI_API_KEY` to a key from
[knyazevai.work](https://knyazevai.work) before starting. Use
`pnpm dsh --profile web` to run the upstream-only composition explicitly.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
