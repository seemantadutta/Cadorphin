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
- Nothing outlives the app, even when it crashes or is killed. On Windows the app joins a job object at startup that kills every process in it when the app's process ends (`reaper.rs`). Shells, the agents in them and the CAD engine all inherit it. A program started from a Cadorphin terminal therefore closes with the app, as with any terminal window. On macOS and Linux, only a clean quit closes the terminals for now.
- Output that arrives before the UI subscribes to it is buffered and replayed. Multi-byte UTF-8 split across reads is reassembled.
- Windows ConPTY asks the terminal for the cursor position at startup and waits for the answer. xterm.js answers automatically; the PTY test in `terminal.rs` does the same.

### A project's agent

The agent chosen in **New Project**, or the last one started from the terminal "+" menu, becomes the project's agent. When the project is opened again, its first terminal starts that agent and continues the previous conversation:

| Agent | New conversation | Reopening the project |
|---|---|---|
| Claude Code | `claude --session-id <new uuid>` | `claude --resume <id>` of the newest session Claude saved for the project folder (Claude saves one after the first message); a new session if there is none |
| Codex | `codex` | `codex resume --last` (latest session started in the project folder) |
| Gemini CLI | `gemini` | `gemini --resume latest` (Gemini keeps sessions per folder) |
| Aider | `aider --read AGENTS.md` | the same, plus `--restore-chat-history` |
| Custom command | the command | the same command |

Only Claude Code lets the caller choose the session id, so it is the only agent with a stored id. A project with no recorded agent still resumes Claude Code if Claude has saved sessions for its folder, so projects created before this existed, and sessions started by hand with `claude`, continue too. The project's agent and session id live in the app's per-user settings, keyed by project folder, not in the project: they are specific to this machine and shouldn't be committed. To find a folder's Claude sessions, Rust lists `<id>.jsonl` files in `CLAUDE_CONFIG_DIR` or `~/.claude`, under `projects/<folder path with every non-alphanumeric character replaced by ->`; it only reads.

## Parameters panel (M3)

Editing a value calls `writeParams()`, which runs `cadkit set` in the engine. The file watcher then sees `params.toml` change and rebuilds, the same path as an agent's or an editor's edit. There's no separate "GUI changed it" route.

## Menus and Preferences

The native menu bar has **File** (New Project…, Open Project…, Close Project, Exit), **Edit** (Preferences…, Ctrl+,) and **Help** (About). Rust only emits a `menu` event with the item's id; the UI decides what to do. Menu shortcuts are taken before the focused terminal sees the key, so none may collide with keys terminal programs use (Ctrl+C, Ctrl+O, Ctrl+Q and so on). For the same reason the standard Cut/Copy/Paste items exist only on macOS.

Preferences has three sections: **Printer**, **Appearance** (theme) and **Viewer** (mouse controls). Theme and controls are per-user UI settings in local storage. The printer is a project setting: it is `profile` in `project.toml`, written by `cadkit set-profile`, because `cadkit check` and agents in the terminal must test against the same build volume. The status bar shows it and opens Preferences when clicked.

## Projects

- **New Project** asks for a name, a parent folder, a template and a printer, then runs `cadkit new` in the engine and opens the result. The folder name is checked in the UI and again in Rust, which refuses separators and other characters that aren't allowed in folder names on Windows.
- **Open Project** accepts any folder with a `model.py`. Anything else is refused with cadkit's message, and the current project stays open.
- **Close Project** stops the file watcher and returns to the start screen, which lists recent projects (most recent first, up to 8, kept in local storage). The app reopens the last project at launch, unless it was closed.
- Terminals belong to a project: leaving it (open, new or close) closes them, because an agent left running in the old folder would keep editing a project that is no longer on screen. If you have typed in a terminal, or started it from an agent shortcut, Cadorphin asks first. A build still running for the old project is discarded when it finishes.

## Checks and export (M4)

- **Check** (top bar, Ctrl+Shift+C) runs `cadkit check --full`: the fast checks plus thin walls, small features and renders. It gets the export's longer timeout. The Problems tab lists the results. Click one to glide the view to its marker, and use **Send to agent** to paste it into the active terminal (the current terminal tab, else the one last used) without pressing Enter. After a full check, the tab links to the renders, which open as image tabs next to the code tabs. A rebuild clears the last full check, so its renders and wall results are never shown for a changed model.
- **Problem markers** stay a fixed size on screen and show through the model: red for errors, amber for warnings, larger for the selected problem.
- **Export** (top bar, File → Export…, Ctrl+Shift+E) asks which bodies to export, a format and a folder (`.cad/export` in the project by default; the choice is remembered per project), then runs the full check.
  - **Bodies:** one checkbox per body, with **All**, **None** and **Visible in viewer**. The app remembers, per project, the bodies left out (not the ones ticked), so new bodies start ticked. With every body ticked the app sends no list, so the files keep their usual names; with exactly one body, the STEP and 3MF files are named `<project>-<body>`. The sidebar's **Export this body…** (in a body's details, or right-click its row) opens the dialog with only that body ticked, and that choice is not remembered. **Always export all bodies** in the dialog, or Preferences → Export, turns the list off.
  - The full check covers all bodies, so the Problems tab stays complete, but the dialog only shows and blocks on problems whose bodies are all being exported. An overlap between an exported body and one left out doesn't block, because they end up in different files.
  - No problems: it exports, and a short notice with **Open folder** fades after a few seconds.
  - Only warnings: it exports, and the notice stays until dismissed, with **Show problems**.
  - Errors: the dialog lists them, with **Fix** (opens the Problems tab), **Export anyway** (`force`) and **Cancel**.
- **The printer profile** is chosen in Preferences (see Menus and Preferences).

## Point-and-fix

Click a face or edge in the viewer, then tell the agent what to change ("make this hole bigger", "chamfer these edges").

- **cadkit tags the mesh.** `topology.py` meshes each B-rep face separately and writes the viewer GLB with a `_FACE_ID` on every vertex. Next to it, `<body>.topo.json` describes every face (type, area, centre, normal, radius and axis, concave or convex) and edge (type, length, ends, the two faces it joins, a polyline for drawing). It also recognises holes, including ones split into half-cylinders, and groups identical holes ("1 of 4"). Seam edges are left out.
- **The viewer picks.** Hover highlights the face or edge under the cursor; an edge within 7 px wins over the face behind it. Click selects, Shift+click adds or removes, Ctrl+drag boxes, Esc clears. A box takes the visible edges fully inside it, or the visible faces if there are none. Edges are drawn from the topology, not guessed from creases.
- **The agent is told.** On every change the app writes `.cad/selection.json` (geometry, plain-language descriptions, hole groups) and `.cad/selection.png` (the view with the selection highlighted). The next time a terminal gets focus, a one-line reference is pasted into it, once, as a bracketed paste, so it lands in the agent's prompt without being sent. The agent rules tell agents what that reference means.
- **Ids are per build.** Face and edge ids index `shape.faces()` and `shape.edges()` and change when the model changes, so a rebuild clears the selection, and the agent only ever sees geometry.

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
