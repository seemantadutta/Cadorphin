# Architecture

```
Tauri v2 desktop shell (Rust)                         [M2]
├── Frontend: React + TypeScript + Vite               app/src
│   ├── Viewer pane: three.js                         [M2]
│   ├── Terminal pane: xterm.js                       [M3]
│   ├── Side panels: files, parameters, bodies, problems
│   └── Export dialog                                 [M4]
├── Rust backend                                      [M2]
│   ├── PTY sessions (portable-pty) <-> xterm.js
│   ├── File watcher (notify, ~300 ms debounce)
│   └── Runs cadkit as a subprocess, with a timeout
└── Python package: cadkit                            cadkit/  [M1, done]
    ├── build   -> per-body GLB + .cad/manifest.json
    ├── check   -> problems as text or JSON
    └── export  -> STEP / STL / 3MF
```

## Key decisions

**All CAD work happens in cadkit.** The desktop app only orchestrates and displays. The app calls the same CLI an agent would, so the two cannot drift apart.

**The model runs in a worker process.** `cadkit <command>` writes a request file to `.cad/tmp/` and starts `python -m cadkit.worker` with a timeout. The worker imports `model.py`, runs `build(params)` and the requested operation, and writes a JSON result. A script that hangs, crashes or prints noise never affects the CLI's output or the app. Everything the script printed comes back in the result's `log` field, for the Build log tab.

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
