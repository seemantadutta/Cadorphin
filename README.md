# Cadorphin

**Design 3D-printable parts by talking to the coding agent you already use.**

Cadorphin is an open-source desktop app for makers and electronics hobbyists. You describe the part to Claude Code, Codex or any other CLI agent in a terminal pane. The agent edits a parametric [build123d](https://github.com/gumyr/build123d) script. The 3D view updates live, checks catch problems before you print, and export gives you STEP, STL or multi-body 3MF for any slicer.

> **Status:** early development. The CAD engine (`cadkit`) and the desktop app's live 3D viewer work today. The built-in agent terminal and the export dialog are next. See the [roadmap](#roadmap).

## Principles

- **Agent-agnostic.** No private API. The agent edits files and runs `cadkit` commands, like a person would.
- **Local-first.** No accounts, no cloud, no telemetry.
- **Code is the source of truth.** A model is `model.py` plus `params.toml` in a git-friendly folder. Exports are build outputs.
- **Printer-agnostic.** Printer facts come from JSON profiles. Export, then open the file in any slicer.
- **Model-first UI.** The 3D view is the main surface. Code is one click away.

## Try the CAD engine

Requires Python 3.11 or 3.12.

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

## Run the desktop app (development)

Requires the steps above, plus [Rust](https://rustup.rs), Node 20+ and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
cd app
npm install
npm run tauri dev        # then "Open folder…" on the welcome screen
```

To open a project straight away, set `CADORPHIN_PROJECT` to its folder. The repo includes a small demo, an open box with rounded corners:

```sh
CADORPHIN_PROJECT="$PWD/../examples/demo" npm run tauri dev               # macOS / Linux
$env:CADORPHIN_PROJECT = "$PWD\..\examples\demo"; npm run tauri dev       # Windows PowerShell
```

The app also reopens the last project you used. To start on the start screen instead, set `CADORPHIN_NO_PROJECT=1` (or pass `--no-project`). Keep your own projects outside this repository; **File → New Project…** remembers the folder you create them in.

The app watches the project folder and rebuilds whenever a file is saved, whether by you, your editor or your agent. Development builds use the repo's `.venv`. To use another Python, set `CADORPHIN_PYTHON`. `npm run dev` alone shows the UI in a browser with fixture data.

## Repository layout

```
app/         desktop app: Tauri shell (src-tauri/) and React + TypeScript frontend (src/)
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
- [x] **M2** Desktop shell and 3D viewer, live rebuild on file change
- [ ] **M3** Terminal pane and agent loop, parameters panel
- [ ] **M4** Full checks (thin walls, renders), Problems tab, export dialog, profile picker

## Security

Cadorphin runs Python code from your project folder (`model.py`), written by you or by an agent. Only open projects you trust. Nothing outside the project folder is run automatically.

## License

[Apache-2.0](LICENSE)
