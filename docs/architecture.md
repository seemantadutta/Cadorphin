# Architecture

```
Tauri v2 desktop shell (Rust)                         app/src-tauri   [M2, done]
├── Frontend: React + TypeScript + Vite               app/src
│   ├── Viewer pane: three.js                         app/src/viewer  [M2, done]
│   ├── Terminal pane: xterm.js, user's shell     app/src/terminal [M3]
│   ├── Side panels: files, editable parameters, bodies
│   └── Export dialog                                                 [M4]
├── Rust backend                                      app/src-tauri/src
│   ├── PTY sessions (portable-pty) <-> xterm.js  terminal.rs
│   ├── File watcher (notify, 300 ms debounce)        lib.rs
│   └── CAD engine: one `python -m cadkit serve`      engine.rs
└── Python package: cadkit                            cadkit/         [M1, done]
    ├── build   -> per-body GLB + .cad/manifest.json
    ├── check   -> problems as text or JSON
    ├── export  -> STEP / STL / 3MF
    ├── info    -> project name, profile, parameters, files
    └── serve   -> long-lived JSON-lines worker for the app
```

## Terminals (M3)

The bottom panel's terminal tabs run **the user's own shell** in a PTY (`portable-pty`), started in the project folder. On Windows that's PowerShell 7 if installed, else Windows PowerShell, else `cmd`; elsewhere it's `$SHELL` as a login shell. Cadorphin doesn't assume any particular agent. The "+" menu has shortcuts for well-known agent CLIs (Claude Code, Codex, Gemini CLI, Aider) and a custom command box. A shortcut only opens a normal terminal and types the command; add entries in `app/src/terminal/agents.ts`.

- The engine's Python scripts folder is put first on the terminal's `PATH`, so `cadkit` in the terminal is the same one the app uses.
- Terminals stay alive while their tab is hidden or the panel is collapsed. Closing a tab, or quitting the app, kills its shell.
- Output that arrives before the UI subscribes to it is buffered and replayed. Multi-byte UTF-8 split across reads is reassembled.
- Windows ConPTY asks the terminal for the cursor position at startup and waits for the answer. xterm.js answers automatically; the PTY test in `terminal.rs` does the same.

## Parameters panel (M3)

Editing a value calls `writeParams()`, which runs `cadkit set` in the engine. The file watcher then sees `params.toml` change and rebuilds, the same path as an agent's or an editor's edit. There's no separate "GUI changed it" route.

## The rebuild loop (M2)

1. The Rust watcher sees a change to `*.py`, `*.toml` or `boards/**`, waits for 300 ms of quiet, then emits `files-changed`. It ignores `.cad/`, `__pycache__/` and `.git/`, so builds can't trigger themselves.
2. The UI asks for `projectInfo()`, to refresh the parameters and file list, then `build()`. An edit that arrives during a build queues exactly one more build.
3. Rust forwards the build to the running `cadkit serve` process. It returns the manifest JSON, and the UI loads each body's GLB through `loadAsset()`.
4. The viewer swaps all bodies at once and keeps the camera where it was. A failed build keeps the last good model on screen and shows the traceback in the Build log.

On the enclosure template, a rebuild takes about 0.8 s, about 1.1 s from saving the file to the view updating.

## Key decisions

**All CAD work happens in cadkit.** The desktop app only orchestrates and displays. The app calls the same CLI an agent would, so the two cannot drift apart.

**The model runs in a worker process.** From the command line, `cadkit <command>` writes a request file to `.cad/tmp/` and starts `python -m cadkit.worker` with a timeout. The worker imports `model.py`, runs `build(params)` and the requested operation, and writes a JSON result. A script that hangs, crashes or prints noise never affects the CLI's output. Everything the script printed comes back in the result's `log` field, for the Build log tab.

**The desktop app keeps one worker alive (decided in M2).** Importing build123d takes about 3 s, longer than the 2 s rebuild target on its own. So the app starts one `python -m cadkit serve` process, which imports build123d once and then answers JSON-lines requests. Each request runs the same `execute()` code as the CLI worker, with the project's modules reloaded, so the results are identical. Rust enforces the timeout (30 s for builds, 120 s for exports) by killing the worker. The next request starts a fresh one. Stray C-level output is sent to stderr, so stdout carries only protocol lines.

**Finding Python (v1 requires the user to install it).** In order: `CADORPHIN_PYTHON`, then the repo's `.venv` (debug builds only), then `python` (Windows) or `python3` on `PATH`. If the engine can't start, the welcome screen shows what was tried and how to fix it.

**Coordinates.** cadkit's GLBs are in metres with a Y-up root rotation, as glTF requires. The viewer undoes both, so the whole scene is Z-up millimetres, matching the model, the manifest and the problem locations.

**The frontend does not depend on Tauri.** Every frontend-to-backend call goes through the `Backend` interface in `app/src/backend/types.ts`. Components get it from `useBackend()`. Only files in `app/src/backend/` may import `@tauri-apps/*`, and an ESLint rule enforces this. A later browser version can swap in a `WebSocketBackend` without UI changes. Message shapes are cadkit's JSON output, unchanged.

**Python environment (decided in M1).** v1 uses **one shared, app-managed virtual environment** with cadkit and build123d installed. Every project runs with that interpreter. Per-project venvs would each need a ~500 MB OpenCASCADE install. Projects stay plain folders (`model.py`, `params.toml`, `project.toml`). We can add a per-project override later if a project needs extra packages.

**Data files.** Printer profiles (`profiles/`) and project templates (`templates/`) live at the repo root. The cadkit wheel bundles them. In a development install, cadkit reads them from the repo (`cadkit/resources.py`).

## Mesh quality

| Output | Setting |
|---|---|
| GLB (viewer) | `--quality coarse` (default) or `fine`. Uses OpenCASCADE relative deflection. |
| STL, 3MF (export) | Fine: 0.01 mm chordal tolerance, 0.1 rad angular. |

3MF meshes are welded so they are watertight by index, which slicers need.

## Security

Cadorphin runs Python code from the project folder (`model.py`), written by you or by an agent. That is the point of the tool, but it means you should only open projects you trust. cadkit runs nothing outside the project folder on its own.
