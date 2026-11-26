# cadkit

The CAD engine behind Cadorphin. It runs a project's `model.py` (build123d), checks the result and exports it.
The desktop app and coding agents both use the same CLI.

```
cadkit new demo --template enclosure
cd demo
cadkit check
cadkit export --format 3mf
```

See [`docs/cadkit-cli.md`](../docs/cadkit-cli.md) for the full CLI reference.
