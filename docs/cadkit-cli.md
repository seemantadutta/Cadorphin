# cadkit CLI reference

`cadkit` is the CAD engine behind Cadorphin. Coding agents and the desktop app use the same commands, so anything the GUI can do, an agent can do from a terminal.

## Common behaviour

- `path` is the project folder (default: the current folder). It must contain `model.py`.
- `--json` prints one JSON object instead of text.
- `--timeout SECONDS` (default 30, or the `CADKIT_TIMEOUT` environment variable). `model.py` runs in a separate worker process, which is killed when the time runs out.
- Exit codes:

| Code | Meaning |
|---|---|
| 0 | OK. Warnings may still be listed. |
| 1 | Problems found: at least one `error` problem. |
| 2 | Script or project error: `model.py` raised, `params.toml` or `project.toml` is invalid, or there is no project. |
| 3 | Timeout. |

## `cadkit new <dir> [--template enclosure|blank] [--profile ID]`

Creates a project from a template. The folder must be new or empty. It generates `CLAUDE.md` and `AGENTS.md` (the rules for agents), `project.toml` (with the chosen printer profile, default `generic-256`) and `.gitignore`.

- `enclosure`: a two-part case with lid, M2.5 heat-set insert bosses, a USB-C cutout and a separate light-pipe body.
- `blank`: a single parametric cube.

## `cadkit build [path] [--quality coarse|fine]`

Runs `model.py` and writes one GLB per valid body to `.cad/out/<body>.glb`, plus `.cad/manifest.json`. GLBs from bodies that no longer exist are deleted. The manifest is written even when the script fails, so the app can show the error.

```json
{
  "ok": true,
  "duration_ms": 2950,
  "bodies": [
    {"name": "case", "material": "PETG", "color": "#3A3F4A",
     "bbox": [72.0, 44.0, 26.0], "bbox_min": [-36.0, -22.0, 0.0],
     "volume_mm3": 21733.2, "valid": true, "glb": ".cad/out/case.glb"}
  ],
  "problems": [],
  "errors": [],
  "profile": "generic-256"
}
```

`build` checks only that each body is a valid solid (`valid`). Run `check` for the build-volume and overlap checks.

## `cadkit check [path] [--fast | --full]`

**Fast** (the default):
- The script runs.
- Each body is a valid, closed solid with positive volume.
- Each body fits the profile's build volume, as modelled. The message says if it would fit rotated.
- No two bodies overlap. Touching faces are allowed.
- Parameter values are inside their `min`/`max`. Values outside produce a warning.

**Full**: the thin-wall and small-feature checks and the PNG renders are not implemented yet (milestone M4). For now `--full` runs the fast checks and adds a note saying so.

Text output:

```
✓ Script ran in 2.3 s
✓ 3 bodies: case, lid, light_pipe
✗ a and b overlap by 500.0 mm³ near (2.5, 0.0, 0.0)
1 problem found
```

JSON output has `ok`, `exit_code`, `duration_ms`, `script_ms`, `bodies` (as in the manifest, without `glb`), `problems`, `errors`, `notes` and `log` (anything the script printed).

Each problem has:

| Field | Meaning |
|---|---|
| `severity` | `error` blocks export. `warning` does not. |
| `code` | `script_error`, `not_solid`, `invalid_solid`, `open_shell`, `too_large`, `overlap` or `param_range`. |
| `message` | Human-readable text. |
| `body` | Optional. The body the problem is about. |
| `bodies` | Optional. All bodies involved, e.g. both bodies in an overlap. |
| `location` | Optional. `[x, y, z]` in mm, for the viewer to highlight. |

## `cadkit export [path] --format step|stl|3mf [--out DIR] [--force]`

Runs the fast checks first. If there are errors, nothing is exported and the exit code is 1, unless you pass `--force`. The default output folder is `.cad/export/`.

| Format | Output |
|---|---|
| `step` | `<project>.step`: one file, all bodies, each labelled with its name and colour. |
| `stl` | `<project>-<body>.stl`: one file per body. |
| `3mf` | `<project>.3mf`: one file, one named mesh object per body, with its material name and display colour, so slicers can assign filaments. Meshes are welded (watertight) and in millimetres. |

## `cadkit profiles`

Lists the printer profiles. See [profiles.md](profiles.md).

## `cadkit info [path]`

Prints the project name, printer profile, parameters (with their `unit`, `min`, `max`, `label` and `group`) and the project files. It reads files but never runs `model.py`. With `--json`:

```json
{"ok": true, "root": "/path/demo", "name": "demo", "units": "mm",
 "profile": {"id": "generic-256", "name": "Generic 256", "build_volume_mm": [256, 256, 256], "plate_mm": [256, 256]},
 "params": [{"name": "wall", "value": 2.2, "unit": "mm", "min": 1.2, "max": 5, "label": "Wall thickness", "group": "Case"}],
 "params_error": null,
 "files": ["AGENTS.md", "CLAUDE.md", "model.py", "params.toml", "project.toml"]}
```

## `cadkit serve`

A long-lived worker for the desktop app. Importing build123d takes about 3 s, so the app starts this once and sends it requests, instead of paying that cost on every rebuild.

- It reads one JSON request per line on stdin: `{"id": 1, "op": "build" | "check" | "export" | "info" | "shutdown", "project": "<path>", ...}`. Other fields are the same options as the matching command, e.g. `"quality"`, `"level"`, `"format"`, `"out"` or `"force"`.
- It writes one line per request on stdout: `{"id": 1, "result": {...}}`. The result is the same JSON the matching command prints with `--json`. If the request itself is malformed, it writes `{"id": 1, "error": "..."}` instead.
- The first line it writes is `{"ready": true, "cadkit": "...", "build123d": "...", "startup_ms": ...}`.
- It handles requests one at a time. Project modules are reloaded for every request, so edits to `model.py` and helper modules always take effect.
- The caller enforces timeouts by killing the process.
- It exits on `shutdown` or when stdin closes.

## The `model.py` contract

```python
from build123d import *
from cadkit import Body

def build(p):
    case = Box(p.length, p.width, p.height)
    return {"case": Body(case, material="PETG", color="#3A3F4A")}
```

- `build(p)` returns a non-empty dict. Keys are body names: letters, digits, `_` and `-`. Values are `cadkit.Body` objects or bare build123d shapes.
- `p` gives access to `params.toml` as `p.name` or `p["name"]`.
- `Body.material` defaults to `[materials] default` in `project.toml`. `Body.color` is `#RRGGBB`.
- The project folder is on `sys.path`, so `model.py` can import helpers such as `boards/`.
