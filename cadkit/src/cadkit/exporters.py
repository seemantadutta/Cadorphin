"""Mesh and CAD file writers: GLB (viewer), STEP, STL and multi-body 3MF."""

from __future__ import annotations

from pathlib import Path

from .body import DEFAULT_COLOR, Body

# Tessellation presets. GLB uses OCCT's relative deflection; STL/3MF use absolute mm tolerance.
QUALITY = {
    "coarse": {"glb_linear": 0.005, "glb_angular": 0.4, "mesh_tol_mm": 0.05, "mesh_ang": 0.3},
    "fine": {"glb_linear": 0.001, "glb_angular": 0.15, "mesh_tol_mm": 0.01, "mesh_ang": 0.1},
}


def _hex_to_rgb(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def _tagged(name: str, body: Body):
    """Shape with label and color set, for formats that carry them."""
    from build123d import Color

    shape = body.shape
    shape.label = name
    shape.color = Color(body.color or DEFAULT_COLOR)
    return shape


def write_glb(name: str, body: Body, path: Path, quality: str = "coarse") -> None:
    from build123d import export_gltf

    q = QUALITY[quality]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not export_gltf(_tagged(name, body), str(path), binary=True, linear_deflection=q["glb_linear"], angular_deflection=q["glb_angular"]):
        raise RuntimeError(f"GLB export failed for {name}")


def write_step(bodies: dict[str, Body], path: Path) -> None:
    from build123d import Compound, export_step

    path.parent.mkdir(parents=True, exist_ok=True)
    assembly = Compound(children=[_tagged(n, b) for n, b in bodies.items()])
    assembly.label = path.stem
    if not export_step(assembly, str(path)):
        raise RuntimeError("STEP export failed")


def write_stl(name: str, body: Body, path: Path, quality: str = "fine") -> None:
    from build123d import export_stl

    q = QUALITY[quality]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not export_stl(body.shape, str(path), tolerance=q["mesh_tol_mm"], angular_tolerance=q["mesh_ang"]):
        raise RuntimeError(f"STL export failed for {name}")


def weld_mesh(verts, tris, decimals: int = 6):
    """Merge duplicate vertices (OCCT tessellates face by face) so the mesh is watertight
    by index, and drop triangles that collapse to a line."""
    index: dict[tuple[float, float, float], int] = {}
    out_verts: list[tuple[float, float, float]] = []
    remap = []
    for v in verts:
        key = (round(v.X, decimals), round(v.Y, decimals), round(v.Z, decimals))
        i = index.get(key)
        if i is None:
            i = index[key] = len(out_verts)
            out_verts.append((v.X, v.Y, v.Z))
        remap.append(i)
    out_tris = []
    for t in tris:
        a, b, c = remap[t[0]], remap[t[1]], remap[t[2]]
        if a != b and b != c and a != c:
            out_tris.append((a, b, c))
    return out_verts, out_tris


def write_3mf(bodies: dict[str, Body], path: Path, quality: str = "fine") -> None:
    """One 3MF with one named, colored mesh object per body, so slicers can assign filaments."""
    import lib3mf

    q = QUALITY[quality]
    wrapper = lib3mf.Wrapper()
    model = wrapper.CreateModel()
    model.SetUnit(lib3mf.ModelUnit.MilliMeter)
    materials = model.AddBaseMaterialGroup()

    for name, body in bodies.items():
        verts, tris = weld_mesh(*body.shape.tessellate(q["mesh_tol_mm"], q["mesh_ang"]))
        positions = []
        for x, y, z in verts:
            p = lib3mf.Position()
            p.Coordinates[0], p.Coordinates[1], p.Coordinates[2] = x, y, z
            positions.append(p)
        triangles = []
        for a, b, c in tris:
            tri = lib3mf.Triangle()
            tri.Indices[0], tri.Indices[1], tri.Indices[2] = a, b, c
            triangles.append(tri)

        mesh = model.AddMeshObject()
        mesh.SetName(name)
        mesh.SetGeometry(positions, triangles)
        r, g, b = _hex_to_rgb(body.color or DEFAULT_COLOR)
        mat_id = materials.AddMaterial(body.material or name, wrapper.RGBAToColor(r, g, b, 255))
        mesh.SetObjectLevelProperty(materials.GetResourceID(), mat_id)
        model.AddBuildItem(mesh, wrapper.GetIdentityTransform())

    path.parent.mkdir(parents=True, exist_ok=True)
    model.QueryWriter("3mf").WriteToFile(str(path))
