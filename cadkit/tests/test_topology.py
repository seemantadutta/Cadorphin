"""Face/edge-tagged viewer meshes and their descriptions (point-and-fix)."""

from __future__ import annotations

import json
import struct

PLATE = """
from build123d import *
from cadkit import Body

def build(p):
    plate = Box(60, 40, 4, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x in (-25, 25):
        for y in (-15, 15):
            plate -= Pos(x, y, 0) * Cylinder(1.6, 20)
    plate = fillet(plate.edges().filter_by(Axis.Z), 3)
    return {"plate": Body(plate, color="#4C8BF5")}
"""


def _read_glb(path):
    data = path.read_bytes()
    magic, version, total = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67 and version == 2 and total == len(data)
    jlen, jtype = struct.unpack_from("<II", data, 12)
    assert jtype == 0x4E4F534A
    gltf = json.loads(data[20 : 20 + jlen])
    blen, btype = struct.unpack_from("<II", data, 20 + jlen)
    assert btype == 0x004E4942
    return gltf, data[28 + jlen : 28 + jlen + blen]


def test_build_writes_tagged_glb_and_topology(make_project, cli):
    root = make_project(PLATE)
    code, res = cli("build", str(root))
    assert code == 0, res
    (body,) = res["bodies"]
    assert body["glb"] == ".cad/out/plate.glb" and body["topo"] == ".cad/out/plate.topo.json"

    topo = json.loads((root / body["topo"]).read_text(encoding="utf-8"))
    assert topo["body"] == "plate" and topo["units"] == "mm"
    n_faces = len(topo["faces"])

    gltf, binary = _read_glb(root / body["glb"])
    prim = gltf["meshes"][0]["primitives"][0]
    assert set(prim["attributes"]) == {"POSITION", "NORMAL", "_FACE_ID"}
    acc = gltf["accessors"][prim["attributes"]["_FACE_ID"]]
    view = gltf["bufferViews"][acc["bufferView"]]
    ids = struct.unpack_from(f"<{acc['count']}f", binary, view["byteOffset"])
    assert {int(i) for i in ids} == set(range(n_faces))  # every face is in the mesh, nothing else
    # Z-up millimetres in the data, converted to glTF's Y-up metres by the root node.
    node = gltf["nodes"][0]
    assert node["scale"] == [0.001] * 3 and abs(node["rotation"][0] + 0.7071) < 1e-3


def test_holes_are_recognised_and_grouped(make_project, cli):
    root = make_project(PLATE)
    cli("build", str(root))
    topo = json.loads((root / ".cad/out/plate.topo.json").read_text(encoding="utf-8"))
    holes = [f for f in topo["features"] if f["kind"] == "hole"]
    assert len(holes) == 4  # the four mounting holes; the rounded corners are convex, not holes
    assert {h["diameter"] for h in holes} == {3.2} and {h["depth"] for h in holes} == {4.0}
    assert {h["group_size"] for h in holes} == {4}
    assert sorted(tuple(h["center"][:2]) for h in holes) == [(-25, -15), (-25, 15), (25, -15), (25, 15)]
    corner = next(f for f in topo["faces"] if f["type"] == "cylinder" and f.get("radius") == 3.0)
    assert corner["concave"] is False


def test_edges_skip_seams_and_know_their_faces(make_project, cli):
    root = make_project(PLATE)
    cli("build", str(root))
    topo = json.loads((root / ".cad/out/plate.topo.json").read_text(encoding="utf-8"))
    assert all(len(e["faces"]) == 2 for e in topo["edges"])  # seams (one face) are left out
    circles = [e for e in topo["edges"] if e["type"] == "circle" and e.get("radius") == 1.6]
    assert len(circles) == 8  # top and bottom rim of each hole
    top_rim = [e for e in topo["edges"] if e["type"] == "line" and e["start"][2] == 4.0 and e["end"][2] == 4.0]
    assert top_rim and all(len(e["points"]) == 2 for e in top_rim)


def test_stale_viewer_files_are_removed(make_project, cli):
    root = make_project(PLATE)
    cli("build", str(root))
    (root / "model.py").write_text(PLATE.replace('"plate"', '"base"'), encoding="utf-8")
    cli("build", str(root))
    out = root / ".cad" / "out"
    assert sorted(p.name for p in out.iterdir()) == ["base.glb", "base.topo.json"]
