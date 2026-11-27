"""Face- and edge-tagged viewer meshes, for point-and-fix.

The viewer shows triangles; the agent edits build123d code. To turn a click into something the
agent can act on, every triangle must know which B-rep face it came from, and every face and edge
needs a description in terms the agent can find in model.py: type, size, position, orientation.

For each body this writes:

- ``<body>.glb``: the viewer mesh. Each face is meshed on its own, so vertices are not shared
  across faces (sharp edges shade crisply). Every vertex carries a ``_FACE_ID`` attribute. Same
  units and axes as before: metres, Y-up via the root node, as glTF expects.
- ``<body>.topo.json``: faces, edges (with polylines for drawing), and recognised features
  (holes, and groups of identical holes).

Face and edge ids are indices into ``shape.faces()`` and ``shape.edges()``. They are only stable
within one build: a selection is described by geometry, never by id, when it reaches the agent.
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path
from typing import Any

from .body import DEFAULT_COLOR, Body

ROUND = 3  # decimals in topo.json (micrometres)


def _r(v: float) -> float:
    return round(float(v), ROUND) + 0.0  # + 0.0 turns -0.0 into 0.0


def _vec(v) -> list[float]:
    return [_r(v.X), _r(v.Y), _r(v.Z)]


def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


# ------------------------------------------------------------------ meshing


def mesh_faces(shape, linear: float, angular: float, relative: bool = True):
    """Mesh every face. Returns (positions, normals, indices, face_ids, centroids): flat lists in
    mm, one entry of face_ids per vertex, and one point on each face (a triangle centroid).
    `linear` is relative to each edge's size when `relative`, else an absolute tolerance in mm."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepLib import BRepLib_ToolTriangulatedShape
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopAbs import TopAbs_REVERSED
    from OCP.TopLoc import TopLoc_Location

    BRepMesh_IncrementalMesh(shape.wrapped, linear, relative, angular, True)
    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []
    face_ids: list[float] = []
    centroids: list[list[float] | None] = []
    for fid, face in enumerate(shape.faces()):
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
        if tri is None or tri.NbTriangles() == 0:
            centroids.append(None)
            continue
        if not tri.HasNormals():
            BRepLib_ToolTriangulatedShape.ComputeNormals_s(face.wrapped, tri)
        trsf = loc.Transformation()
        reversed_ = face.wrapped.Orientation() == TopAbs_REVERSED
        base = len(positions) // 3
        for i in range(1, tri.NbNodes() + 1):
            p = tri.Node(i).Transformed(trsf)
            positions += (p.X(), p.Y(), p.Z())
            n = tri.Normal(i).Transformed(trsf)
            s = -1.0 if reversed_ else 1.0
            normals += (s * n.X(), s * n.Y(), s * n.Z())
            face_ids.append(float(fid))
        for k in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(k).Get()
            if reversed_:
                b, c = c, b
            indices += (base + a - 1, base + b - 1, base + c - 1)
        a, b, c = indices[-3], indices[-2], indices[-1]
        centroids.append([_r(sum(positions[3 * v + j] for v in (a, b, c)) / 3) for j in range(3)])
    return positions, normals, indices, face_ids, centroids


def _pad4(b: bytes, fill: bytes = b"\0") -> bytes:
    return b + fill * ((4 - len(b) % 4) % 4)


def write_tagged_glb(name: str, color: str, mesh, path: Path) -> None:
    """A minimal glTF 2.0 binary: one mesh with POSITION, NORMAL, _FACE_ID and indices."""
    positions, normals, indices, face_ids, _ = mesh
    n_verts = len(positions) // 3
    blobs = [
        struct.pack(f"<{len(positions)}f", *positions),
        struct.pack(f"<{len(normals)}f", *normals),
        struct.pack(f"<{len(face_ids)}f", *face_ids),
        struct.pack(f"<{len(indices)}I", *indices),
    ]
    views, offset = [], 0
    for i, blob in enumerate(blobs):
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob), "target": 34963 if i == 3 else 34962})
        offset += len(_pad4(blob))
    xs, ys, zs = positions[0::3], positions[1::3], positions[2::3]
    r, g, b = (int(color.lstrip("#")[i : i + 2], 16) / 255 for i in (0, 2, 4))
    s45 = math.sqrt(0.5)
    gltf: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "cadkit"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        # Model data is Z-up millimetres; glTF wants Y-up metres. The root node converts.
        "nodes": [{"name": name, "mesh": 0, "rotation": [-s45, 0, 0, s45], "scale": [0.001, 0.001, 0.001]}],
        "meshes": [{"name": name, "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "_FACE_ID": 2}, "indices": 3, "material": 0}]}],
        "materials": [{"name": name, "pbrMetallicRoughness": {
            "baseColorFactor": [_srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b), 1.0],
            "metallicFactor": 0.0, "roughnessFactor": 0.6}}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": n_verts, "type": "VEC3",
             "min": [min(xs), min(ys), min(zs)] if n_verts else [0, 0, 0], "max": [max(xs), max(ys), max(zs)] if n_verts else [0, 0, 0]},
            {"bufferView": 1, "componentType": 5126, "count": n_verts, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": n_verts, "type": "SCALAR"},
            {"bufferView": 3, "componentType": 5125, "count": len(indices), "type": "SCALAR"},
        ],
        "bufferViews": views,
        "buffers": [{"byteLength": offset}],
    }
    bin_chunk = b"".join(_pad4(b) for b in blobs)
    json_chunk = _pad4(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk)
        f.write(struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk)


# ------------------------------------------------------------------ descriptions


def _type_name(shape) -> str:
    return str(shape.geom_type).split(".")[-1].lower()


def _describe_face(fid: int, face, point: list[float] | None) -> dict[str, Any]:
    from build123d import Vector
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Sphere, GeomAbs_Torus

    bb = face.bounding_box()
    d: dict[str, Any] = {
        "id": fid,
        "type": _type_name(face),
        "area": _r(face.area),
        "center": _vec(face.center()),
        "bbox": [_vec(bb.min), _vec(bb.max)],
    }
    if point is not None:
        d["point"] = point
    at = Vector(*point) if point is not None else face.center()
    try:
        d["normal"] = _vec(face.normal_at(at))
    except Exception:  # noqa: BLE001 - degenerate faces have no normal
        pass
    s = BRepAdaptor_Surface(face.wrapped)
    kind = s.GetType()
    if kind in (GeomAbs_Cylinder, GeomAbs_Cone):
        geom = s.Cylinder() if kind == GeomAbs_Cylinder else s.Cone()
        ax = geom.Axis()
        loc, direction = ax.Location(), ax.Direction()
        d["axis"] = {"point": [_r(loc.X()), _r(loc.Y()), _r(loc.Z())], "dir": [_r(direction.X()), _r(direction.Y()), _r(direction.Z())]}
        if kind == GeomAbs_Cylinder:
            d["radius"] = _r(geom.Radius())
            if "normal" in d:
                # Concave (the normal points at the axis) means a hole or pocket wall; convex, a boss.
                p = Vector(*d.get("point", d["center"]))
                a = Vector(*d["axis"]["point"])
                u = Vector(*d["axis"]["dir"])
                radial = (p - a) - u * (p - a).dot(u)
                d["concave"] = radial.dot(Vector(*d["normal"])) < 0
        else:
            d["half_angle_deg"] = _r(math.degrees(geom.SemiAngle()))
    elif kind == GeomAbs_Sphere:
        d["radius"] = _r(s.Sphere().Radius())
    elif kind == GeomAbs_Torus:
        d["major_radius"], d["minor_radius"] = _r(s.Torus().MajorRadius()), _r(s.Torus().MinorRadius())
    return d


def _edge_points(edge, length: float, kind: str) -> list[list[float]]:
    if kind == "line":
        n = 1
    else:
        n = max(8, min(96, int(length / 0.75)))  # about 0.75 mm segments on curves
    return [_vec(edge.position_at(i / n)) for i in range(n + 1)]


def _describe_edge(eid: int, edge, faces: list[int]) -> dict[str, Any]:
    kind = _type_name(edge)
    length = edge.length
    d: dict[str, Any] = {
        "id": eid,
        "type": kind,
        "length": _r(length),
        "start": _vec(edge.position_at(0)),
        "end": _vec(edge.position_at(1)),
        "mid": _vec(edge.position_at(0.5)),
        "faces": faces,
        "points": _edge_points(edge, length, kind),
    }
    if kind == "circle":
        try:
            d["radius"] = _r(edge.radius)
            d["center"] = _vec(edge.arc_center)
        except Exception:  # noqa: BLE001
            pass
    return d


def _holes(faces: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Concave cylinders, merged when they share an axis and radius (OCCT often splits a hole
    wall into two half-cylinders), then grouped into sets of identical holes."""
    walls = [f for f in faces if f["type"] == "cylinder" and f.get("concave")]
    holes: list[dict[str, Any]] = []

    def same_axis(a: dict[str, Any], b: dict[str, Any]) -> bool:
        da, db = a["axis"]["dir"], b["axis"]["dir"]
        if abs(abs(sum(x * y for x, y in zip(da, db))) - 1) > 1e-3:
            return False
        pa, pb = a["axis"]["point"], b["axis"]["point"]
        diff = [q - p for p, q in zip(pa, pb)]
        along = sum(x * y for x, y in zip(diff, da))
        off = math.sqrt(max(0.0, sum(x * x for x in diff) - along * along))
        return off < 1e-3

    for w in walls:
        for h in holes:
            if abs(h["radius"] - w["radius"]) < 1e-3 and same_axis(h["_wall"], w):
                h["faces"].append(w["id"])
                h["_extent"] += [w["bbox"][0], w["bbox"][1]]
                break
        else:
            holes.append({"faces": [w["id"]], "radius": w["radius"], "_wall": w, "_extent": [w["bbox"][0], w["bbox"][1]]})

    out = []
    for i, h in enumerate(holes):
        u = h["_wall"]["axis"]["dir"]
        a = h["_wall"]["axis"]["point"]
        # Project the walls' bounding-box corners on the axis to get its depth and middle.
        ts = [sum((p[k] - a[k]) * u[k] for k in range(3)) for p in h["_extent"]]
        t0, t1 = min(ts), max(ts)
        mid = [_r(a[k] + u[k] * (t0 + t1) / 2) for k in range(3)]
        out.append({"kind": "hole", "id": i, "faces": h["faces"], "diameter": _r(2 * h["radius"]),
                    "depth": _r(t1 - t0), "axis_dir": u, "center": mid})

    # Identical holes: same diameter, depth and axis direction.
    groups: list[list[dict[str, Any]]] = []
    for h in out:
        for g in groups:
            r = g[0]
            if (abs(r["diameter"] - h["diameter"]) < 1e-3 and abs(r["depth"] - h["depth"]) < 1e-2
                    and abs(abs(sum(x * y for x, y in zip(r["axis_dir"], h["axis_dir"]))) - 1) < 1e-3):
                g.append(h)
                break
        else:
            groups.append([h])
    for gi, g in enumerate(groups):
        for h in g:
            h["group"] = gi
            h["group_size"] = len(g)
            h["group_centers"] = [x["center"] for x in g]
    return out


def describe(name: str, shape, centroids: list[list[float] | None]) -> dict[str, Any]:
    faces = shape.faces()
    edges = shape.edges()
    index = {e: i for i, e in enumerate(edges)}
    adjacent: dict[int, list[int]] = {i: [] for i in range(len(edges))}
    for fid, f in enumerate(faces):
        for e in f.edges():
            i = index.get(e)
            if i is not None and fid not in adjacent[i]:
                adjacent[i].append(fid)
    face_d = [_describe_face(i, f, centroids[i] if i < len(centroids) else None) for i, f in enumerate(faces)]
    edge_d = []
    for i, e in enumerate(edges):
        if len(adjacent[i]) < 2:
            continue  # a seam (a cylinder meeting itself): not a real edge, never drawn or picked
        edge_d.append(_describe_edge(i, e, adjacent[i]))
    return {"body": name, "units": "mm", "faces": face_d, "edges": edge_d, "features": _holes(face_d)}


def write_viewer_files(name: str, body: Body, glb_path: Path, linear: float, angular: float) -> Path:
    """Write <body>.glb (tagged) and <body>.topo.json next to it. Returns the topo path."""
    mesh = mesh_faces(body.shape, linear, angular)
    write_tagged_glb(name, body.color or DEFAULT_COLOR, mesh, glb_path)
    topo = describe(name, body.shape, mesh[4])
    topo_path = glb_path.with_suffix(".topo.json")
    topo_path.write_text(json.dumps(topo, separators=(",", ":")), encoding="utf-8")
    return topo_path
