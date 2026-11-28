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

## `cadkit new <dir> [--template enclosure|blank|empty] [--profile ID] [--description TEXT]`

Creates a project from a template. The folder must be new or empty. It generates `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` (the rules for agents; Claude Code, Codex and most others, and Gemini CLI each read their own file). With `--description`, the text is appended to each of them as a **Design brief** section after the generated rules, so an agent starts out knowing what the design is for. It also writes `project.toml` (with the chosen printer profile, default `generic-256`) and `.gitignore`.

- `enclosure`: a two-part case with lid, M2.5 heat-set insert bosses, a USB-C cutout and a separate light-pipe body.
- `blank`: a single parametric cube.
- `empty`: nothing yet. `build()` returns no bodies, ready for you or an agent to fill in. The app's New Project dialog starts with this one.

## `cadkit build [path] [--quality coarse|fine]`

Runs `model.py` and writes one GLB per valid body to `.cad/out/<body>.glb`, plus `.cad/manifest.json`. Each GLB carries a `_FACE_ID` vertex attribute, and `.cad/out/<body>.topo.json` describes its faces, edges and holes, for the app's point-and-fix (see [architecture.md](architecture.md#point-and-fix)). GLBs from bodies that no longer exist are deleted. The manifest is written even when the script fails, so the app can show the error.

```json
{
  "ok": true,
  "duration_ms": 2950,
  "bodies": [
    {"name": "case", "material": "PETG", "color": "#3A3F4A",
     "bbox": [72.0, 44.0, 26.0], "bbox_min": [-36.0, -22.0, 0.0],
     "volume_mm3": 21733.2, "valid": true, "glb": ".cad/out/case.glb", "topo": ".cad/out/case.topo.json"}
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

**Full** (`--full`; the app's Check button and its export dialog run this) adds:
- **Thin walls.** Points are sampled over each body's surface, and a ray from each point straight into the material measures the wall there. Spots below the minimum wall are grouped into connected regions, and each region is reported once, at its thinnest point, with its size.
  - Below the minimum wall: a warning.
  - Thinner than the nozzle over 3 mm or more: an error, because that wall will not print.
  - A smaller region thinner than the nozzle (a sliver where two curves meet, say) is a warning: the slicer simply leaves it out.
- **Small features.** Holes narrower than two nozzle widths may close up, and pins that thin may not print. Both are warnings.
- **Renders.** `iso`, `top`, `front` and `right` views of all bodies, plus `section`: a front view cut through the middle, with the cut faces in red. They are written to `.cad/renders/*.png` (800 x 600), replacing the previous ones, and listed in `renders`. They are drawn in software, so they work without a display.

The minimum wall comes from the printer profile (`defaults.min_wall_mm`, else 1.2 mm), and the nozzle is 0.4 mm if the profile lists it, else its smallest. A project can override both in `project.toml`:

```toml
[checks]
min_wall_mm = 1.0
nozzle_mm = 0.6
```

The JSON output of a full check also has `renders` and `checks` (the limits used).

Text output:

```
✓ Script ran in 2.3 s
✓ 3 bodies: case, lid, light_pipe
✗ a and b overlap by 500.0 mm³ near (2.5, 0.0, 0.0)
⚠ Thin wall: case, 0.9 mm over about 20 x 8 mm (min 1.2 mm) near (12.0, -17.0, 4.0)
Renders: .cad/renders/iso.png .cad/renders/top.png .cad/renders/front.png .cad/renders/right.png .cad/renders/section.png
1 problem and 1 warning found
```

JSON output has `ok`, `exit_code`, `duration_ms`, `script_ms`, `bodies` (as in the manifest, without `glb`), `problems`, `errors`, `notes` and `log` (anything the script printed).

Each problem has:

| Field | Meaning |
|---|---|
| `severity` | `error` blocks export. `warning` does not. |
| `code` | `script_error`, `not_solid`, `invalid_solid`, `open_shell`, `too_large`, `overlap`, `param_range`, `no_bodies` (export of a model with no bodies), and with `--full` also `thin_wall` and `small_feature`. |
| `message` | Human-readable text. |
| `body` | Optional. The body the problem is about. |
| `bodies` | Optional. All bodies involved, e.g. both bodies in an overlap. |
| `location` | Optional. `[x, y, z]` in mm, for the viewer to highlight. |

## `cadkit export [path] --format step|stl|3mf [--out DIR] [--force] [--bodies A,B]`

Runs the fast checks first. If there are errors, nothing is exported and the exit code is 1, unless you pass `--force`. The default output folder is `.cad/export/`.

`--bodies` exports only the named bodies (comma-separated). Only those bodies are checked, so an error on a body you left out does not block the export. An unknown name is an error. When exactly one body is chosen, the STEP and 3MF files are named `<project>-<body>` so they do not replace the full export.

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
 "profile": {"id": "generic-256", "name": "Generic 256", "vendor": "Generic", "build_volume_mm": [256, 256, 256], "plate_mm": [256, 256]},
 "params": [{"name": "wall", "value": 2.2, "unit": "mm", "min": 1.2, "max": 5, "label": "Wall thickness", "group": "Case"}],
 "params_error": null,
 "files": ["AGENTS.md", "CLAUDE.md", "model.py", "params.toml", "project.toml"]}
```

## `cadkit set name=value [name=value ...] [--path DIR]`

Changes parameter values in `params.toml` in place. Only the value text changes: comments, order, the other keys and the file's line endings stay exactly as they were. The desktop app's parameters panel uses this, and agents can too.

- Values take the parameter's existing type. Numbers stay numbers (an integer stays an integer when the new value is whole), and on/off parameters accept `true`/`false`, `on`/`off`, `yes`/`no` or `1`/`0`.
- Only existing parameters can be set. To add one, edit `params.toml`.
- A value outside `min`/`max` is written, with a warning.
- The file is written to a temporary file and then renamed, so file watchers never see half a file.
- It never runs `model.py`. Exit code 2 for an unknown parameter or a bad value; nothing is written in that case.

```
$ cadkit set wall=2.4 length=90
✓ wall = 2.4
✓ length = 90.0
```

## `cadkit set-profile ID [--path DIR]`

Chooses the project's printer by rewriting `profile = "..."` in `project.toml`. Nothing else in the file changes, and the file is replaced atomically, like `cadkit set`. If there is no top-level `profile` key, one is added before the first table. An unknown id exits with code 2 and writes nothing. The desktop app's Preferences → Printer uses this.

```
$ cadkit set-profile bambu-p1s
✓ Printer: Bambu Lab P1S (256 x 256 x 256 mm)
```

## `cadkit serve`

A long-lived worker for the desktop app. Importing build123d takes about 3 s, so the app starts this once and sends it requests, instead of paying that cost on every rebuild.

- It reads one JSON request per line on stdin: `{"id": 1, "op": "build" | "check" | "export" | "info" | "set_params" | "set_profile" | "profiles" | "shutdown", "project": "<path>", ...}`. `set_params` takes `"values": {"name": value}`; `set_profile` takes `"profile": "<id>"`; `profiles` lists printer profiles (bundled, plus the project's own when `project` is given) and needs no project. Other fields are the same options as the matching command, e.g. `"quality"`, `"level"`, `"format"`, `"out"` or `"force"`.
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

- `build(p)` returns a dict. It may be empty while a design has nothing in it yet: that builds and checks cleanly (`check` adds a note), but `export` refuses. Keys are body names: letters, digits, `_` and `-`. Values are `cadkit.Body` objects or bare build123d shapes.
- `p` gives access to `params.toml` as `p.name` or `p["name"]`.
- `Body.material` defaults to `[materials] default` in `project.toml`. `Body.color` is `#RRGGBB`.
- The project folder is on `sys.path`, so `model.py` can import helpers such as `boards/`.
