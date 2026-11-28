# Releasing Cadorphin

Releases are built by `.github/workflows/release.yml` on Windows x64 and macOS (Apple Silicon).

## What a release contains

- **The app**, built by Tauri: an NSIS installer (`-setup.exe`, per-user, no admin rights) and a `.dmg`.
- **A bundled Python.** `scripts/bundle_python.py` downloads a standalone CPython from
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (pinned release and
  version at the top of the script, checked against the release's SHA256SUMS), installs `cadkit` and
  build123d into it, trims Tk, tests and headers, precompiles it and smoke-tests `cadkit new/check/export`.
  The result, `app/src-tauri/python/`, is git-ignored. `app/src-tauri/tauri.release.conf.json` adds it to
  the bundle as a resource; dev builds don't use that file, so they don't need it.
  - At startup the app picks Python in this order: `CADORPHIN_PYTHON`, the repo's `.venv` (dev builds only),
    the bundled one, then `python` on PATH (`engine.rs`). The bundled one runs with `-E -s`, so the user's
    `PYTHONPATH` and site-packages can't leak in.
  - pip's `cadkit` launchers hard-code the build machine's path, so the script replaces them with shims in
    `python/shims/`, which the app puts first on its terminals' PATH.
- **Updater artifacts**: signed update bundles and `latest.json`, which the app reads from
  `https://github.com/seemantadutta/Cadorphin/releases/latest/download/latest.json`.

## Steps

1. Set the version in all four places: `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`,
   `app/package.json`, `cadkit/pyproject.toml` (and `cadkit/src/cadkit/__init__.py`).
2. Merge to `main`, then tag and push: `git tag v1.0.1 && git push origin v1.0.1`.
   The workflow refuses a tag that doesn't match the version in `tauri.conf.json`.
3. When both jobs finish, open the draft release on GitHub, edit the notes and **Publish**.
   Installed copies see the update only after it is published.

To test a build without releasing, run the workflow by hand (Actions → Release → Run workflow). The
installers are kept as workflow artifacts.

## Updater signing key

Updates are signed with a minisign key. The public key is in `tauri.conf.json` (`plugins.updater.pubkey`).
The private key and its password are the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the maintainer keeps the originals offline.

**Don't lose the private key.** Installed copies only accept updates signed with it. Without it, a new
key means everyone has to reinstall by hand.

## Building an installer locally

```sh
python scripts/bundle_python.py          # once, or after cadkit's dependencies change
cd app
# set TAURI_SIGNING_PRIVATE_KEY (the key's contents) and TAURI_SIGNING_PRIVATE_KEY_PASSWORD first
npx tauri build --config src-tauri/tauri.release.conf.json
```

The installer lands in `app/src-tauri/target/release/bundle/`.

## Not done yet

- Code signing: Windows Authenticode, and macOS Developer ID signing plus notarization (needs an Apple
  Developer account). Until then, users see a one-time SmartScreen or Gatekeeper prompt.
- Intel Macs and Linux.
