from __future__ import annotations

import json
import subprocess
import sys

import pytest

from cadkit.project import ProjectError, list_profiles, load_profile, load_project, set_profile
from cadkit.worker import execute


def _project(tmp_path, toml: str | None, newline: str = "\n"):
    (tmp_path / "model.py").write_text("def build(p):\n    return {}\n", encoding="utf-8")
    if toml is not None:
        (tmp_path / "project.toml").write_bytes(toml.replace("\n", newline).encode())
    return tmp_path


def test_bambu_profiles_present():
    ids = list_profiles()
    for pid in ("bambu-a1-mini", "bambu-a1", "bambu-p1s", "bambu-x1c", "bambu-h2d"):
        assert pid in ids
    assert load_profile("bambu-a1-mini").build_volume_mm == (180, 180, 180)
    assert load_profile("bambu-p1s").vendor == "Bambu Lab"
    assert load_profile("generic-256").vendor == "Generic"


def test_set_profile_keeps_everything_else(tmp_path):
    toml = 'name = "demo"\nprofile = "generic-256"   # my printer\nunits = "mm"\n\n[materials]\ndefault = "PETG"\n'
    root = _project(tmp_path, toml)
    prof = set_profile(root, "bambu-a1-mini")
    assert prof.name == "Bambu Lab A1 mini"
    assert (root / "project.toml").read_text(encoding="utf-8") == toml.replace("generic-256", "bambu-a1-mini")
    assert load_project(root).profile.build_volume_mm == (180, 180, 180)


def test_set_profile_keeps_crlf(tmp_path):
    root = _project(tmp_path, 'name = "demo"\nprofile = \'generic-256\'\n', newline="\r\n")
    set_profile(root, "bambu-p1s")
    assert (root / "project.toml").read_bytes() == b'name = "demo"\r\nprofile = "bambu-p1s"\r\n'


def test_set_profile_adds_key_before_tables(tmp_path):
    root = _project(tmp_path, 'name = "demo"\n\n[materials]\ndefault = "PLA"\n\n[x]\nprofile = "not-this-one"\n')
    set_profile(root, "bambu-x1c")
    text = (root / "project.toml").read_text(encoding="utf-8")
    assert text.startswith('name = "demo"\nprofile = "bambu-x1c"\n\n[materials]')
    assert 'profile = "not-this-one"' in text


def test_set_profile_without_project_toml(tmp_path):
    root = _project(tmp_path, None)
    set_profile(root, "bambu-a1")
    assert (root / "project.toml").read_text(encoding="utf-8") == 'profile = "bambu-a1"\n'


def test_set_profile_unknown_id_writes_nothing(tmp_path):
    toml = 'profile = "generic-256"\n'
    root = _project(tmp_path, toml)
    with pytest.raises(ProjectError, match="Unknown printer profile"):
        set_profile(root, "nope")
    assert (root / "project.toml").read_text(encoding="utf-8") == toml


def test_worker_ops(tmp_path):
    root = _project(tmp_path, 'profile = "generic-256"\n')
    res = execute({"op": "profiles", "project": str(root)})
    assert res["ok"] and any(p["id"] == "bambu-p1s" and p["vendor"] == "Bambu Lab" for p in res["profiles"])
    res = execute({"op": "set_profile", "project": str(root), "profile": "bambu-h2d"})
    assert res["ok"] and res["profile"]["build_volume_mm"] == [325, 320, 325]
    assert execute({"op": "info", "project": str(root)})["profile"]["id"] == "bambu-h2d"
    bad = execute({"op": "set_profile", "project": str(root), "profile": "nope"})
    assert not bad["ok"] and bad["exit_code"] == 2


def test_cli_set_profile(tmp_path):
    root = _project(tmp_path, 'profile = "generic-256"\n')
    r = subprocess.run([sys.executable, "-m", "cadkit", "set-profile", "bambu-p1s", "--path", str(root), "--json"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["profile"]["name"] == "Bambu Lab P1S"


def test_worker_templates_and_new(tmp_path):
    res = execute({"op": "templates"})
    assert [t["id"] for t in res["templates"]][:3] == ["empty", "enclosure", "blank"]
    assert all(t["description"] for t in res["templates"])
    res = execute({"op": "new", "dir": str(tmp_path / "box"), "template": "blank", "profile": "bambu-a1-mini"})
    assert res["ok"], res
    assert load_project(res["path"]).profile.id == "bambu-a1-mini"
    again = execute({"op": "new", "dir": str(tmp_path / "box"), "template": "blank"})
    assert not again["ok"] and "not empty" in again["errors"][0]


def test_new_with_design_brief(tmp_path):
    brief = "A wall mount for a Feather board.\r\nIt hangs on a single screw."
    res = execute({"op": "new", "dir": str(tmp_path / "m"), "template": "blank", "description": brief})
    assert res["ok"], res
    root = tmp_path / "m"
    for fname in ("CLAUDE.md", "AGENTS.md", "GEMINI.md"):
        text = (root / fname).read_text(encoding="utf-8")
        assert "cadkit check --full" in text  # the generated rules are still there...
        assert text.rstrip().endswith("A wall mount for a Feather board.\nIt hangs on a single screw.")  # ...and the brief follows
        assert text.count("## Design brief") == 1


def test_new_without_brief_has_no_section(tmp_path):
    res = execute({"op": "new", "dir": str(tmp_path / "m"), "template": "blank", "description": "   "})
    assert res["ok"]
    assert "Design brief" not in (tmp_path / "m" / "CLAUDE.md").read_text(encoding="utf-8")
