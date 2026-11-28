"""`cadkit new` templates, the example project, and 3MF/STEP output."""

from __future__ import annotations

from collections import Counter

import pytest

from conftest import REPO


def read_3mf(path):
    """Return [(name, material, '#RRGGBB', vertices, triangles)] for each mesh object."""
    import lib3mf

    w = lib3mf.Wrapper()
    model = w.CreateModel()
    model.QueryReader("3mf").ReadFromFile(str(path))
    objs = []
    it = model.GetMeshObjects()
    while it.MoveNext():
        o = it.GetCurrentMeshObject()
        rid, pid, has = o.GetObjectLevelProperty()
        assert has, f"{o.GetName()} has no material"
        group = model.GetBaseMaterialGroupByID(rid)
        c = group.GetDisplayColor(pid)
        verts = [tuple(v.Coordinates) for v in o.GetVertices()]
        tris = [tuple(t.Indices) for t in o.GetTriangleIndices()]
        objs.append((o.GetName(), group.GetName(pid), f"#{c.Red:02X}{c.Green:02X}{c.Blue:02X}", verts, tris))
    assert model.GetBuildItems().Count() == len(objs)
    return objs


def is_closed_mesh(tris) -> bool:
    edges = Counter()
    for a, b, c in tris:
        for e in ((a, b), (b, c), (c, a)):
            edges[tuple(sorted(e))] += 1
    return all(n == 2 for n in edges.values())


def signed_volume(verts, tris) -> float:
    vol = 0.0
    for a, b, c in tris:
        (x1, y1, z1), (x2, y2, z2), (x3, y3, z3) = verts[a], verts[b], verts[c]
        vol += (x1 * (y2 * z3 - z2 * y3) - y1 * (x2 * z3 - z2 * x3) + z1 * (x2 * y3 - y2 * x3)) / 6
    return vol


def test_enclosure_template_end_to_end(tmp_path, cli, monkeypatch):
    """M1 acceptance: new -> check -> export --format 3mf with separate named bodies."""
    code, res = cli("new", str(tmp_path / "demo"), "--template", "enclosure")
    assert code == 0, res
    demo = tmp_path / "demo"
    monkeypatch.chdir(demo)

    code, res = cli("check")
    assert code == 0, res
    assert res["problems"] == []
    assert [b["name"] for b in res["bodies"]] == ["case", "lid", "light_pipe"]
    volumes = {b["name"]: b["volume_mm3"] for b in res["bodies"]}

    code, res = cli("export", "--format", "3mf")
    assert code == 0, res
    assert res["files"] == [".cad/export/demo.3mf"]

    objs = read_3mf(demo / ".cad" / "export" / "demo.3mf")
    assert [(o[0], o[1], o[2]) for o in objs] == [
        ("case", "PETG", "#3A3F4A"),
        ("lid", "PETG", "#5B6475"),
        ("light_pipe", "Clear PETG", "#CFEFF7"),
    ]
    for name, _, _, verts, tris in objs:
        assert is_closed_mesh(tris), f"{name} mesh is not closed"
        vol = signed_volume(verts, tris)
        assert vol > 0, f"{name} mesh is inside out"
        assert vol == pytest.approx(volumes[name], rel=0.02)


def test_enclosure_step_export_names_bodies(tmp_path, cli):
    cli("new", str(tmp_path / "box"), "--template", "enclosure")
    code, res = cli("export", str(tmp_path / "box"), "--format", "step")
    assert code == 0, res
    step = (tmp_path / "box" / ".cad" / "export" / "box.step").read_text(encoding="utf-8", errors="replace")
    for name in ("case", "lid", "light_pipe"):
        assert f"'{name}'" in step


def test_new_generates_agent_rules(tmp_path, cli):
    code, _ = cli("new", str(tmp_path / "p"), "--template", "blank", "--profile", "generic-180")
    assert code == 0
    p = tmp_path / "p"
    assert {f.name for f in p.iterdir()} >= {"model.py", "params.toml", "project.toml", "CLAUDE.md", "AGENTS.md", "GEMINI.md", ".gitignore"}
    for f in ("CLAUDE.md", "AGENTS.md", "project.toml"):
        text = (p / f).read_text(encoding="utf-8")
        assert "{{" not in text, f"unrendered placeholder in {f}"
    assert "cadkit info" in (p / "CLAUDE.md").read_text(encoding="utf-8")  # the printer can change, so it isn't baked in
    assert "Claude Code" in (p / "CLAUDE.md").read_text(encoding="utf-8")
    assert 'profile = "generic-180"' in (p / "project.toml").read_text(encoding="utf-8")
    assert ".cad/" in (p / ".gitignore").read_text(encoding="utf-8")

    code, res = cli("check", str(p))
    assert code == 0, res


def test_new_refuses_non_empty_dir(tmp_path, cli):
    (tmp_path / "busy").mkdir()
    (tmp_path / "busy" / "file.txt").write_text("x")
    code, res = cli("new", str(tmp_path / "busy"))
    assert code == 2 and "not empty" in res["errors"][0]


def test_new_unknown_template(tmp_path, cli):
    code, res = cli("new", str(tmp_path / "x"), "--template", "nope")
    assert code == 2 and "Unknown template" in res["errors"][0]


def test_example_project(cli):
    code, res = cli("check", str(REPO / "examples" / "wall-bracket"))
    assert code == 0, res
    assert res["profile"] == "generic-220"
    assert [b["name"] for b in res["bodies"]] == ["bracket"]


def test_demo_project(cli):
    """examples/demo is the box the app's dev setup opens; it must stay a valid, hollow, open box."""
    code, res = cli("check", str(REPO / "examples" / "demo"))
    assert code == 0, res
    (box,) = res["bodies"]
    assert box["name"] == "box" and box["bbox"] == [60.0, 40.0, 25.0]
    assert 0 < box["volume_mm3"] < 0.5 * 60 * 40 * 25  # hollow, not a solid block


def test_export_chosen_bodies(tmp_path, cli, monkeypatch):
    code, res = cli("new", str(tmp_path / "demo"), "--template", "enclosure")
    assert code == 0, res
    demo = tmp_path / "demo"
    monkeypatch.chdir(demo)

    code, res = cli("export", "--format", "3mf", "--bodies", "lid")
    assert code == 0, res
    assert res["files"] == [".cad/export/demo-lid.3mf"]
    assert [o[0] for o in read_3mf(demo / ".cad" / "export" / "demo-lid.3mf")] == ["lid"]

    code, res = cli("export", "--format", "3mf", "--bodies", "case, light_pipe")
    assert code == 0, res
    assert res["files"] == [".cad/export/demo.3mf"]
    assert [o[0] for o in read_3mf(demo / ".cad" / "export" / "demo.3mf")] == ["case", "light_pipe"]

    code, res = cli("export", "--format", "stl", "--bodies", "case")
    assert code == 0, res
    assert res["files"] == [".cad/export/demo-case.stl"]

    code, res = cli("export", "--format", "3mf", "--bodies", "nope")
    assert code != 0
    assert res["problems"][0]["code"] == "unknown_body"
