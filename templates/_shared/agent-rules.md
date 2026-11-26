# {{project_name}}: rules for {{agent}}

This folder is a cadkit CAD project. You design the part by editing code; the Cadorphin app shows the model live.

- The model lives in `model.py`, in `build(params)`, written with build123d. Tunable values live in `params.toml`. Prefer adding a parameter over hard-coding a number.
- Read a parameter as `p.name`. Add new ones to `params.toml` as a table with `value`, and give it `unit`, `min`, `max`, `label` and `group` when they make sense. To change only a value, `cadkit set name=value` is quickest; it keeps the file's comments and layout.
- `build(params)` returns a dict of named bodies: `{"case": Body(shape, material="PETG", color="#3A3F4A"), ...}`. Keep each separately printed part or material as its own named body.
- After every change, run `cadkit check --full` and read the output. If the change affects shape, look at `.cad/renders/*.png` when they exist. Do not reply until the checks pass or you have explained the remaining warnings.
- Export with `cadkit export --format 3mf` (or `step`, `stl`). Files go to `.cad/export/`.
- The printer profile is `{{profile}}` ({{profile_name}}), set in `project.toml`. Respect its build volume and its defaults (minimum wall, fit clearance).
- Units are millimetres.
- Do not edit anything in `.cad/`; it is generated.
