"""Locate bundled data (printer profiles, project templates).

Installed wheel: cadkit/_data/<name>. Editable/dev install: <repo>/<name>.
CADKIT_PROFILES_DIR / CADKIT_TEMPLATES_DIR override both.
"""

from __future__ import annotations

import os
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def data_dir(name: str) -> Path:
    env = os.environ.get(f"CADKIT_{name.upper()}_DIR")
    if env:
        return Path(env)
    bundled = _HERE / "_data" / name
    if bundled.is_dir():
        return bundled
    repo = _HERE.parents[2] / name  # src/cadkit -> src -> cadkit/ -> repo root
    if repo.is_dir():
        return repo
    raise FileNotFoundError(f"cadkit data folder '{name}' not found (looked in {bundled} and {repo})")
