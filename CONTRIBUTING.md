# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Development setup

**cadkit (Python 3.10–3.12)**

```sh
python -m venv .venv
.venv/bin/pip install -e "cadkit[dev]"     # Windows: .venv\Scripts\pip ...
cd cadkit && ../.venv/bin/python -m pytest
```

The tests run real models through the CLI and take about a minute.

**Frontend (Node 20+)**

```sh
cd app
npm install
npm run typecheck && npm run lint && npm run build
npm run dev                                 # UI in a browser with fixture data (MockBackend)
```

**Desktop shell (Rust stable + Tauri prerequisites)**

```sh
cd app
npm run tauri dev                           # the real app, using the repo's .venv for cadkit
cd src-tauri && cargo clippy -- -D warnings
```

The `MockBackend` fixtures in `app/src/backend/fixtures/` come from the enclosure template. Regenerate them when the template or the manifest format changes. See the README there.

## Ground rules

- **Agent-agnostic.** If the app needs a capability, it is a `cadkit` command first. The GUI calls the CLI and never does CAD work itself.
- **Frontend talks only to `Backend`.** Only `app/src/backend/` may import `@tauri-apps/*`. The linter enforces this.
- **Keep docs in sync.** `docs/cadkit-cli.md` must match the CLI. Update it in the same pull request.
- **Ask before adding heavy dependencies** or changing the architecture in `docs/architecture.md`. Open an issue first.
- Small, focused commits with clear messages.

## Printer profiles

New printer profiles are very welcome. See [docs/profiles.md](docs/profiles.md). Write the numbers from the manufacturer's spec sheet. Do not copy files from slicers.

## License

By contributing, you agree that your contributions are licensed under the [Apache-2.0](LICENSE) licence.
