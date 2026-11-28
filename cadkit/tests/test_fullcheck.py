"""`cadkit check --full`: thin walls, small features and renders."""

from __future__ import annotations

import struct

CUP = """
from build123d import *
from cadkit import Body

def build(p):
    outer = Box(40, 30, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))
    inner = Pos(0, 0, 2) * Box(40 - 2 * {wall}, 30 - 2 * {wall}, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))
    cup = outer - inner
    {extra}
    return {{"cup": Body(cup, color="#4C8BF5")}}
"""


def cup(wall: float, extra: str = "") -> str:
    return CUP.format(wall=wall, extra=extra)


def codes(res, code):
    return [p for p in res["problems"] if p["code"] == code]


def test_thin_walls_are_one_region_with_a_location(make_project, cli):
    code, res = cli("check", "--full", str(make_project(cup(0.8))))
    thin = codes(res, "thin_wall")
    assert len(thin) == 1, thin  # the whole thin wall is one region, not one problem per sample
    p = thin[0]
    assert p["severity"] == "warning" and p["body"] == "cup" and len(p["location"]) == 3
    assert "0.8 mm" in p["message"] and "min 1.2 mm" in p["message"]
    assert code == 0  # warnings don't fail the check


def test_wall_thinner_than_the_nozzle_is_an_error(make_project, cli):
    code, res = cli("check", "--full", str(make_project(cup(0.3))))
    thin = codes(res, "thin_wall")
    assert thin and thin[0]["severity"] == "error" and "nozzle" in thin[0]["message"]
    assert code == 1


def test_healthy_walls_with_inside_fillets_report_nothing(make_project, cli):
    # Inside fillets are where a naive mesh-based ray test reports 0 mm walls.
    extra = "cup = fillet(cup.edges().filter_by(Axis.Z), 0.5)"
    code, res = cli("check", "--full", str(make_project(cup(2.0, extra))))
    assert codes(res, "thin_wall") == [], res["problems"]
    assert code == 0


def test_project_can_set_the_minimum_wall(make_project, cli):
    root = make_project(cup(1.0))
    (root / "project.toml").write_text('profile = "generic-256"\n\n[checks]\nmin_wall_mm = 0.9\n', encoding="utf-8")
    code, res = cli("check", "--full", str(root))
    assert codes(res, "thin_wall") == [] and res["checks"]["min_wall_mm"] == 0.9


def test_small_holes_are_reported(make_project, cli):
    extra = "cup -= Pos(10, 0, 0) * Cylinder(0.3, 10)"
    _, res = cli("check", "--full", str(make_project(cup(2.0, extra))))
    small = codes(res, "small_feature")
    assert len(small) == 1 and "Ø0.6 mm" in small[0]["message"] and small[0]["location"][:2] == [10.0, 0.0]


def test_renders_are_written(make_project, cli):
    root = make_project(cup(2.0))
    _, res = cli("check", "--full", str(root))
    assert res["renders"] == [f".cad/renders/{v}.png" for v in ("iso", "top", "front", "right", "section")]
    for r in res["renders"]:
        data = (root / r).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        w, h = struct.unpack(">II", data[16:24])
        assert (w, h) == (800, 600)


def test_fast_check_does_none_of_this(make_project, cli):
    root = make_project(cup(0.8))
    _, res = cli("check", str(root))
    assert codes(res, "thin_wall") == [] and "renders" not in res
    assert not (root / ".cad" / "renders").exists()
