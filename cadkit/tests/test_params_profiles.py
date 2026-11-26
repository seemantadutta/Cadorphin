from __future__ import annotations

import json

import pytest

from cadkit.params import ParamError, load_params
from cadkit.project import ProjectError, list_profiles, load_profile
from conftest import REPO


def test_params_both_forms(tmp_path):
    (tmp_path / "params.toml").write_text(
        'name = "box"\nflag = true\n\n[wall]\nvalue = 2.2\nunit = "mm"\nmin = 0.8\nmax = 5\nlabel = "Wall"\ngroup = "Case"\n',
        encoding="utf-8",
    )
    p = load_params(tmp_path)
    assert p.wall == 2.2 and p["wall"] == 2.2
    assert p.name == "box" and p.flag is True
    assert p.specs["wall"].to_json() == {"name": "wall", "value": 2.2, "unit": "mm", "min": 0.8, "max": 5, "label": "Wall", "group": "Case"}
    assert p.out_of_range() == []
    with pytest.raises(AttributeError, match="No parameter named 'missing'"):
        _ = p.missing


def test_params_missing_file_is_empty(tmp_path):
    assert list(load_params(tmp_path)) == []


@pytest.mark.parametrize(
    "text, match",
    [("[wall]\nunit = 'mm'\n", "has no 'value'"), ("[wall]\nvalue = 1\nmaxx = 3\n", "unknown keys: maxx"), ("wall = = 1", "params.toml")],
)
def test_params_errors(tmp_path, text, match):
    (tmp_path / "params.toml").write_text(text, encoding="utf-8")
    with pytest.raises(ParamError, match=match):
        load_params(tmp_path)


def test_profiles_match_schema():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((REPO / "profiles" / "schema.json").read_text(encoding="utf-8"))
    ids = list_profiles()
    assert {"generic-180", "generic-220", "generic-256", "generic-300", "bambu-p1s"} <= set(ids)
    for pid in ids:
        data = json.loads((REPO / "profiles" / f"{pid}.json").read_text(encoding="utf-8"))
        jsonschema.validate(data, schema)
        assert data["id"] == pid
        assert load_profile(pid).build_volume_mm[0] > 0


def test_unknown_profile():
    with pytest.raises(ProjectError, match="Unknown printer profile 'nope'"):
        load_profile("nope")


def test_project_local_profile_wins(tmp_path):
    (tmp_path / "profiles").mkdir()
    (tmp_path / "profiles" / "generic-256.json").write_text(
        json.dumps({"id": "generic-256", "name": "Local", "build_volume_mm": [10, 10, 10], "plate_mm": [10, 10], "nozzle_diameters_mm": [0.4]}),
        encoding="utf-8",
    )
    assert load_profile("generic-256", tmp_path).name == "Local"
