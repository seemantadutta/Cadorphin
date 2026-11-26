"""The five model cases from milestone M1, plus timeouts and export gating."""

from __future__ import annotations

VALID = """
from build123d import *
from cadkit import Body

def build(p):
    return {
        "base": Body(Box(20, 20, 5), material="PLA", color="#336699"),
        "knob": Body(Pos(0, 0, 5) * Cylinder(4, 6, align=(Align.CENTER, Align.CENTER, Align.MIN))),
    }
"""


def codes(res):
    return [p["code"] for p in res["problems"]]


def test_valid_model(make_project, cli):
    code, res = cli("check", str(make_project(VALID)))
    assert code == 0, res
    assert res["ok"] and res["problems"] == []
    assert [b["name"] for b in res["bodies"]] == ["base", "knob"]
    base = res["bodies"][0]
    assert base["bbox"] == [20.0, 20.0, 5.0]
    assert abs(base["volume_mm3"] - 2000) < 1e-6
    assert base["material"] == "PLA" and base["color"] == "#336699"


def test_script_error(make_project, cli):
    src = """
    from build123d import *

    def build(p):
        size = p.size * 2
        return {"part": Box(size, size, undefined_name)}
    """
    code, res = cli("check", str(make_project(src, params="size = 10\n")))
    assert code == 2
    assert not res["ok"]
    err = res["errors"][0]
    assert "NameError" in err and "undefined_name" in err
    assert "model.py" in err and "line 6" in err  # traceback points at the user's code
    assert codes(res) == ["script_error"]


def test_missing_build_function(make_project, cli):
    code, res = cli("check", str(make_project("x = 1\n")))
    assert code == 2
    assert "build(params)" in res["errors"][0]


def test_bad_return_type(make_project, cli):
    code, res = cli("check", str(make_project("def build(p):\n    return 42\n")))
    assert code == 2
    assert "must return a non-empty dict" in res["errors"][0]


def test_invalid_solid_not_a_solid(make_project, cli):
    src = """
    from build123d import *
    from cadkit import Body

    def build(p):
        return {"flat": Body(Rectangle(10, 10))}
    """
    code, res = cli("check", str(make_project(src)))
    assert code == 1
    assert codes(res) == ["not_solid"]
    assert res["problems"][0]["body"] == "flat"
    assert res["bodies"][0]["valid"] is False


def test_invalid_solid_open_shell(make_project, cli):
    src = """
    from build123d import *
    from cadkit import Body

    def build(p):
        faces = Box(10, 10, 10).faces()
        leaky = Solid(Shell(faces[:-1]))  # a box with its top face missing
        return {"leaky": Body(leaky)}
    """
    code, res = cli("check", str(make_project(src)))
    assert code == 1
    assert {"open_shell", "invalid_solid"} & set(codes(res)), res["problems"]


def test_overlapping_bodies(make_project, cli):
    src = """
    from build123d import *

    def build(p):
        return {"a": Box(10, 10, 10), "b": Pos(5, 0, 0) * Box(10, 10, 10), "c": Pos(30, 0, 0) * Box(5, 5, 5)}
    """
    code, res = cli("check", str(make_project(src)))
    assert code == 1
    overlaps = [p for p in res["problems"] if p["code"] == "overlap"]
    assert len(overlaps) == 1
    o = overlaps[0]
    assert o["bodies"] == ["a", "b"]
    assert "500.0 mm³" in o["message"]
    assert o["location"] == [2.5, 0.0, 0.0]


def test_touching_bodies_do_not_overlap(make_project, cli):
    src = """
    from build123d import *

    def build(p):
        return {"a": Box(10, 10, 10), "b": Pos(10, 0, 0) * Box(10, 10, 10)}
    """
    code, res = cli("check", str(make_project(src)))
    assert code == 0, res["problems"]


def test_too_large_for_profile(make_project, cli):
    src = """
    from build123d import *

    def build(p):
        return {"long": Box(200, 20, 20)}
    """
    code, res = cli("check", str(make_project(src, profile="generic-180")))
    assert code == 1
    (p,) = res["problems"]
    assert p["code"] == "too_large" and p["body"] == "long"
    assert "Generic 180" in p["message"]

    code, _ = cli("check", str(make_project(src, profile="generic-220", name="fits")))
    assert code == 0


def test_timeout(make_project, cli):
    src = """
    import time

    def build(p):
        time.sleep(120)
    """
    code, res = cli("check", str(make_project(src)), "--timeout", "8")
    assert code == 3
    assert "Timed out" in res["errors"][0]


def test_param_out_of_range_is_a_warning(make_project, cli):
    src = """
    from build123d import *

    def build(p):
        return {"part": Box(p.size, p.size, p.size)}
    """
    params = """
    [size]
    value = 50
    max = 40
    """
    code, res = cli("check", str(make_project(src, params=params)))
    assert code == 0
    (p,) = res["problems"]
    assert p["severity"] == "warning" and p["code"] == "param_range"


def test_export_blocked_by_errors_unless_forced(make_project, cli, tmp_path):
    src = """
    from build123d import *

    def build(p):
        return {"a": Box(10, 10, 10), "b": Pos(5, 0, 0) * Box(10, 10, 10)}
    """
    root = make_project(src)
    code, res = cli("export", str(root), "--format", "stl")
    assert code == 1 and res["files"] == []
    assert not (root / ".cad" / "export").exists()

    out = tmp_path / "forced"
    code, res = cli("export", str(root), "--format", "stl", "--force", "--out", str(out))
    assert code == 1  # problems are still reported
    assert sorted(p.name for p in out.iterdir()) == ["proj-a.stl", "proj-b.stl"]


def test_build_writes_manifest_and_glbs(make_project, cli):
    root = make_project(VALID)
    stale = root / ".cad" / "out" / "old_body.glb"
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"stale")

    code, res = cli("build", str(root))
    assert code == 0, res
    import json

    manifest = json.loads((root / ".cad" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["ok"] is True
    assert [b["name"] for b in manifest["bodies"]] == ["base", "knob"]
    for b in manifest["bodies"]:
        glb = root / b["glb"]
        assert glb.read_bytes()[:4] == b"glTF"
        assert b["valid"] is True
    assert not stale.exists()


def test_build_manifest_on_script_error(make_project, cli):
    root = make_project("def build(p):\n    raise RuntimeError('boom')\n")
    code, res = cli("build", str(root))
    assert code == 2
    import json

    manifest = json.loads((root / ".cad" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["ok"] is False and "boom" in manifest["errors"][0]


def test_not_a_project(tmp_path, cli):
    code, res = cli("check", str(tmp_path))
    assert code == 2
    assert "No model.py" in res["errors"][0]
