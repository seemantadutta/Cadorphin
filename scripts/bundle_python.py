"""Build the Python runtime that release builds of Cadorphin ship with.

    python scripts/bundle_python.py

Downloads a standalone CPython (python-build-standalone), checks its SHA-256, installs cadkit
(and build123d) into it, trims what the app never uses, adds `cadkit` shims for the terminal
and smoke-tests the result. The output is app/src-tauri/python/, which
app/src-tauri/tauri.release.conf.json bundles as a resource. Builds for the machine it runs on.
"""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

PBS_RELEASE = "20261026"
PYTHON_VERSION = "3.12.16"

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "app" / "src-tauri" / "python"
CACHE = REPO / ".cache" / "python-build-standalone"
BASE_URL = f"https://github.com/astral-sh/python-build-standalone/releases/download/{PBS_RELEASE}"
WINDOWS = sys.platform == "win32"


def target_triple() -> str:
    machine = platform.machine().lower()
    if WINDOWS and machine in ("amd64", "x86_64"):
        return "x86_64-pc-windows-msvc"
    if sys.platform == "darwin":
        return "aarch64-apple-darwin" if machine == "arm64" else "x86_64-apple-darwin"
    sys.exit(f"No bundled Python for {sys.platform}/{machine} yet (Windows x64 and macOS only)")


def fetch(name: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / name
    if not dest.exists():
        print(f"Downloading {name}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        with urllib.request.urlopen(f"{BASE_URL}/{name}") as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(dest)
    return dest


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_sums() -> dict[str, str]:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / f"SHA256SUMS-{PBS_RELEASE}"
    if not dest.exists():
        with urllib.request.urlopen(f"{BASE_URL}/SHA256SUMS") as r:
            dest.write_bytes(r.read())
    sums = {}
    for line in dest.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2:
            sums[parts[1]] = parts[0]
    return sums


def python_exe() -> Path:
    return OUT / "python.exe" if WINDOWS else OUT / "bin" / "python3"


def run(*args: str | Path, **kw) -> None:
    print("+", " ".join(str(a) for a in args))
    subprocess.run([str(a) for a in args], check=True, **kw)


def trim() -> None:
    """Drop what a headless CAD engine never needs: Tk, tests, headers, docs, pip's launchers."""
    gone = []
    if WINDOWS:
        lib = OUT / "Lib"
        gone += [OUT / "tcl", OUT / "include", OUT / "libs", OUT / "Scripts"]
        gone += list((OUT / "DLLs").glob("_tkinter*")) + list((OUT / "DLLs").glob("t[ck]*86t.dll"))
    else:
        lib = OUT / "lib" / f"python{PYTHON_VERSION.rsplit('.', 1)[0]}"
        gone += [OUT / "include", OUT / "share"]
        gone += [p for p in (OUT / "lib").iterdir() if p.name.startswith(("tcl", "tk", "itcl", "thread", "libtcl", "libtk"))]
        gone += list((lib / "lib-dynload").glob("_tkinter*"))
        # pip writes entry points with this machine's absolute path in the shebang; the shims replace them
        gone += [p for p in (OUT / "bin").iterdir() if not p.name.startswith("python")]
    gone += [lib / d for d in ("test", "tkinter", "idlelib", "turtledemo", "ensurepip", "lib2to3")]
    gone += list(lib.rglob("__pycache__"))
    for p in gone:
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.exists() or p.is_symlink():
            p.unlink()


def write_shims() -> None:
    """`cadkit` for the app's terminals. pip's own launchers hard-code the build machine's path."""
    shims = OUT / "shims"
    shims.mkdir()
    if WINDOWS:
        (shims / "cadkit.cmd").write_text('@"%~dp0..\\python.exe" -E -s -m cadkit %*\r\n', encoding="ascii")
    else:
        sh = shims / "cadkit"
        sh.write_text('#!/bin/sh\nexec "$(dirname "$0")/../bin/python3" -E -s -m cadkit "$@"\n', encoding="ascii")
        sh.chmod(sh.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def smoke_test() -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    shim = OUT / "shims" / ("cadkit.cmd" if WINDOWS else "cadkit")
    with tempfile.TemporaryDirectory() as tmp:
        run(shim, "--version", env=env, shell=False)
        run(shim, "new", "demo", "--template", "enclosure", cwd=tmp, env=env)
        run(shim, "check", cwd=Path(tmp) / "demo", env=env)
        run(shim, "export", "--format", "3mf", cwd=Path(tmp) / "demo", env=env)


def main() -> None:
    name = f"cpython-{PYTHON_VERSION}+{PBS_RELEASE}-{target_triple()}-install_only_stripped.tar.gz"
    expected = fetch_sums().get(name)
    if not expected:
        sys.exit(f"{name} is not listed in the release's SHA256SUMS")
    archive = fetch(name)
    if sha256(archive) != expected:
        archive.unlink()
        sys.exit(f"Checksum mismatch for {name}; deleted it, run again to re-download")

    if OUT.exists():
        shutil.rmtree(OUT)
    print(f"Extracting to {OUT}")
    with tarfile.open(archive) as tar:  # the archive's top folder is python/
        tar.extractall(OUT.parent, filter="tar")

    py = python_exe()
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    run(py, "-E", "-s", "-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check",
        "--no-warn-script-location", REPO / "cadkit", env=env)
    run(py, "-E", "-s", "-m", "pip", "uninstall", "-y", "--disable-pip-version-check", "pip", env=env)
    trim()
    write_shims()
    # Precompile, so the first start is faster and works where the app folder is read-only (macOS)
    run(py, "-E", "-s", "-m", "compileall", "-q", "-j0", OUT, env=env)
    smoke_test()

    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"Bundled Python ready: {OUT} ({size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
