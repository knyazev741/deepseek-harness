# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @knyazevai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default. Pass `--open` to open the browser automatically. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/knyazev741/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` starts `fork-web` with the KnyazevAI API provider and our workspace plugins. Set `KNYAZEV_AI_API_KEY` to your key from [knyazevai.work](https://knyazevai.work). The provider catalog mirrors the live API: DeepSeek V4 Flash and GLM 5.3 Flash have 400,000-token context windows, MiniMax 2.7 has 204,800, and Kimi 2.6 is retired. DeepSeek and GLM both have up to 20 transient-error retries and compaction at 50% pressure with at most 131,072 input tokens per summary in the standard, ptc, and cordis presets. Use `--profile web` for the original composition. Historical `code` preset selections migrate to `ptc`.

An existing profile may still own `providers.knyazev-ai.models` in `settings.yaml`; that user array replaces the bundle catalog and is intentionally not rewritten by `git pull`. After updating, open **Settings → Models → KnyazevAI API**, choose **Fetch available models**, keep the suggested repairs selected, then choose **Adopt** and **Apply**. This restores reasoning metadata without overwriting tuned capacities. Remove any saved `kimi-2.6` row manually because the live API no longer publishes it.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
