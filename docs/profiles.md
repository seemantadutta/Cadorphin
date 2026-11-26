# Printer profiles

A profile describes a printer: what fits on it and which defaults to design for. Profiles are JSON files in `profiles/`, validated against [`profiles/schema.json`](../profiles/schema.json). A project chooses one in `project.toml`:

```toml
profile = "generic-256"
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase, digits and `-`. Must match the file name. |
| `name` | yes | Display name. |
| `build_volume_mm` | yes | Printable `[x, y, z]`. |
| `plate_mm` | yes | Physical plate `[x, y]`. |
| `nozzle_diameters_mm` | yes | Supported nozzles, e.g. `[0.4]`. |
| `defaults.min_wall_mm` | no | Thinnest wall to allow. Used by the thin-wall check in M4. |
| `defaults.fit_clearance_mm` | no | Gap between mating parts. |
| `defaults.layer_height_mm` | no | Typical layer height. |
| `notes` | no | Free text. |

Cadorphin ships generic profiles only: `generic-180`, `generic-220`, `generic-256` and `generic-300`. Each is a cube printer of that size with a 0.4 mm nozzle.

## Adding your printer

1. Copy a generic profile to `profiles/<your-printer>.json` and fill in the numbers from the manufacturer's spec sheet.
2. Run the tests (`pytest` in `cadkit/`). They validate every profile against the schema.
3. Open a pull request.

Do not copy profile files from slicers. Their licences may not allow it. Write the numbers yourself.

## Project-local profiles

A project can carry its own profile in `<project>/profiles/<id>.json`. It takes precedence over a bundled profile with the same id.
