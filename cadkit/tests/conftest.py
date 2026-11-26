from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest

from cadkit.cli import main

REPO = Path(__file__).resolve().parents[2]


def run_cli(capsys, *args: str) -> tuple[int, dict]:
    """Run the cadkit CLI in-process (the model itself still runs in a worker subprocess)."""
    code = main([*args, "--json"])
    out = capsys.readouterr().out
    return code, json.loads(out)


@pytest.fixture
def make_project(tmp_path):
    """Create a minimal project from model source (and optional params/profile)."""

    def _make(model_src: str, params: str = "", profile: str = "generic-256", name: str = "proj") -> Path:
        root = tmp_path / name
        root.mkdir()
        (root / "model.py").write_text(textwrap.dedent(model_src), encoding="utf-8")
        (root / "params.toml").write_text(textwrap.dedent(params), encoding="utf-8")
        (root / "project.toml").write_text(f'profile = "{profile}"\nunits = "mm"\n', encoding="utf-8")
        return root

    return _make


@pytest.fixture
def cli(capsys):
    return lambda *args: run_cli(capsys, *args)
