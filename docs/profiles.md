# Printer profiles

A profile describes a printer: what fits on it and which defaults to design for. Profiles are JSON files in `profiles/`, validated against [`profiles/schema.json`](../profiles/schema.json). A project chooses one in `project.toml`:

```toml
profile = "generic-256"
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase, digits and `-`. Must match the file name. |
| `name` | yes | Display name. |
| `vendor` | no | Groups the printer list in Cadorphin's Preferences, e.g. `Bambu Lab` or `Generic`. |
| `build_volume_mm` | yes | Printable `[x, y, z]`. |
| `plate_mm` | yes | Physical plate `[x, y]`. |
| `nozzle_diameters_mm` | yes | Supported nozzles, e.g. `[0.4]`. |
| `defaults.min_wall_mm` | no | Thinnest wall to allow. Used by the thin-wall check in M4. |
| `defaults.fit_clearance_mm` | no | Gap between mating parts. |
| `defaults.layer_height_mm` | no | Typical layer height. |
| `notes` | no | Free text. |

Bundled profiles:

| Id | Printer | Build volume (mm) |
|---|---|---|
| `bambu-a1-mini` | Bambu Lab A1 mini | 180 × 180 × 180 |
| `bambu-a1` | Bambu Lab A1 | 256 × 256 × 256 |
| `bambu-p1p` | Bambu Lab P1P | 256 × 256 × 256 |
| `bambu-p1s` | Bambu Lab P1S | 256 × 256 × 256 |
| `bambu-p2s` | Bambu Lab P2S | 256 × 256 × 256 |
| `bambu-x1c` | Bambu Lab X1 Carbon | 256 × 256 × 256 |
| `bambu-x1e` | Bambu Lab X1E | 256 × 256 × 256 |
| `bambu-x2d` | Bambu Lab X2D | 256 × 256 × 260 (main nozzle; 235.5 × 256 × 256 with both) |
| `bambu-h2d` | Bambu Lab H2D | 325 × 320 × 325 (one nozzle; 300 in X when both are used) |
| `bambu-h2s` | Bambu Lab H2S | 340 × 320 × 340 |
| `generic-180` … `generic-300` | Cube printers of that size, 0.4 mm nozzle | 180³, 220³, 256³, 300³ |

## Choosing a project's printer

In Cadorphin: **Edit → Preferences → Printer**, or click the printer in the status bar. From a terminal: `cadkit set-profile bambu-p1s`. Both rewrite only the `profile` line of `project.toml`.

## Adding your printer

1. Copy a generic profile to `profiles/<your-printer>.json` and fill in the numbers from the manufacturer's spec sheet.
2. Run the tests (`pytest` in `cadkit/`). They validate every profile against the schema.
3. Open a pull request.

Do not copy profile files from slicers. Their licences may not allow it. Write the numbers yourself.

## Project-local profiles

A project can carry its own profile in `<project>/profiles/<id>.json`. It takes precedence over a bundled profile with the same id.
