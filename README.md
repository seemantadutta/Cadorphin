# Cadorphin

**Design 3D-printable parts by talking to the coding agent you already use.**

Cadorphin is an open-source desktop app for makers and electronics hobbyists. You describe the part to Claude Code, Codex or any other CLI agent in a terminal pane. The agent edits a parametric [build123d](https://github.com/gumyr/build123d) script. The 3D view updates live, checks catch problems before you print, and export gives you STEP, STL or multi-body 3MF for any slicer.

> **Status:** early development. The CAD engine (`cadkit`) works from the command line today. The desktop app (viewer, terminal, panels) is next. See the [roadmap](#roadmap).

## Principles

- **Agent-agnostic.** No private API. The agent edits files and runs `cadkit` commands, like a person would.
- **Local-first.** No accounts, no cloud, no telemetry.
- **Code is the source of truth.** A model is `model.py` plus `params.toml` in a git-friendly folder. Exports are build outputs.
- **Printer-agnostic.** Printer facts come from JSON profiles. Export, then open the file in any slicer.
- **Model-first UI.** The 3D view is the main surface. Code is one click away.

## Try the CAD engine

Requires Python 3.10–3.12.

```sh
python -m venv .venv
.venv/bin/pip install -e "cadkit[dev]"   # Windows: .venv\Scripts\pip ...

cadkit new demo --template enclosure
cd demo
cadkit check
cadkit export --format 3mf               # -> .cad/export/demo.3mf
```

Open `.cad/export/demo.3mf` in your slicer. The case, lid and light pipe are separate named objects, so you can give the light pipe a different filament.

Then point your agent at the folder. `cadkit new` writes a `CLAUDE.md` / `AGENTS.md` that tells it how to work: edit `model.py` and `params.toml`, then run `cadkit check --full` after every change.

## Repository layout

```
app/         desktop app: Tauri shell (M2) and React + TypeScript frontend
cadkit/      Python CAD engine and CLI
profiles/    printer profiles (JSON) and their schema
templates/   project templates: blank, enclosure
examples/    sample projects used in tests
docs/        architecture, CLI reference, profiles, UI mockups
```

## Documentation

- [Architecture](docs/architecture.md)
- [cadkit CLI reference](docs/cadkit-cli.md)
- [Printer profiles](docs/profiles.md)

## Roadmap

- [x] **M0** Repo skeleton and CI
- [x] **M1** `cadkit` core: `new`, `build`, `check --fast`, `export` (STEP, STL, 3MF)
- [ ] **M2** Desktop shell and 3D viewer, live rebuild on file change
- [ ] **M3** Terminal pane and agent loop, parameters panel
- [ ] **M4** Full checks (thin walls, renders), Problems tab, export dialog, profile picker

## Security

Cadorphin runs Python code from your project folder (`model.py`), written by you or by an agent. Only open projects you trust. Nothing outside the project folder is run automatically.

## License

[Apache-2.0](LICENSE)
