"""`cadkit check --full`: thin walls, small features, and PNG renders.

Thin walls are measured by sampling points on each body's surface and casting a ray from each
point straight into the material (against the outward normal). The distance to where the ray
leaves the material is the local wall thickness. Spots thinner than the minimum wall are grouped
into regions, and each region is reported once, at its thinnest point.

Renders are drawn by a small software rasterizer (numpy z-buffer, 2x supersampled, shaded faces
plus the real CAD edges), so they work headless on any machine, CI included.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path
from typing import Any

import numpy as np

from .body import DEFAULT_COLOR, Body
from .checks import Problem

DEFAULT_MIN_WALL_MM = 1.2
DEFAULT_NOZZLE_MM = 0.4
MAX_SAMPLES_PER_BODY = 6000
MAX_REGIONS_PER_BODY = 8
SLIVER_MAX_MM = 3.0  # a sub-nozzle region smaller than this is a sliver (warning), larger is a missing wall (error)


# ------------------------------------------------------------------ settings


def check_settings(project) -> dict[str, float]:
    """Minimum wall and nozzle size: project.toml [checks] wins over the printer profile."""
    from .tomlcompat import tomllib

    checks: dict[str, Any] = {}
    cfg_path = project.root / "project.toml"
    if cfg_path.is_file():
        try:
            checks = tomllib.loads(cfg_path.read_text(encoding="utf-8")).get("checks", {}) or {}
        except tomllib.TOMLDecodeError:
            checks = {}
    prof = project.profile
    nozzles = prof.nozzle_diameters_mm or [DEFAULT_NOZZLE_MM]
    nozzle = float(checks.get("nozzle_mm") or (DEFAULT_NOZZLE_MM if DEFAULT_NOZZLE_MM in nozzles else min(nozzles)))
    min_wall = float(checks.get("min_wall_mm") or prof.defaults.get("min_wall_mm") or DEFAULT_MIN_WALL_MM)
    return {"min_wall_mm": min_wall, "nozzle_mm": nozzle}


# ------------------------------------------------------------------ meshes


# Triangles lie within this distance of the true surface (absolute meshing tolerance, mm).
SAMPLE_SAG_MM = 0.05


def _mesh_arrays(shape):
    """(vertices Nx3, triangles Mx3, face id per triangle) with outward winding, in mm."""
    from .topology import mesh_faces

    positions, _normals, indices, face_ids, _ = mesh_faces(shape, SAMPLE_SAG_MM, 0.3, relative=False)
    v = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    t = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    fid = np.asarray(face_ids, dtype=np.int64)[t[:, 0]] if len(t) else np.zeros(0, dtype=np.int64)
    return v, t, fid


def _fmt(v: float) -> str:
    return f"{v:.1f}"


# ------------------------------------------------------------------ thin walls


def thin_walls(name: str, body: Body, min_wall: float, nozzle: float) -> list[Problem]:
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

    v, t, _ = _mesh_arrays(body.shape)
    if not len(t):
        return []
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    cross = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cross, axis=1)
    ok = area2 > 1e-12
    a, b, c, cross, area2 = a[ok], b[ok], c[ok], cross[ok], area2[ok]
    normals = cross / area2[:, None]  # outward: mesh_faces keeps the winding outward
    total = float(area2.sum() / 2)
    spacing = max(0.75, min_wall * 0.8)
    n = int(min(MAX_SAMPLES_PER_BODY, max(400, total / (spacing * spacing))))
    rng = np.random.default_rng(0)  # same samples every run: results don't flicker
    tri = rng.choice(len(a), size=n, p=area2 / area2.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    pts = (1 - s)[:, None] * a[tri] + (s * (1 - r2))[:, None] * b[tri] + (s * r2)[:, None] * c[tri]
    nrm = normals[tri]

    inter = IntCurvesFace_ShapeIntersector()
    inter.Load(body.shape.wrapped, 1e-4)
    eps = 1e-3
    # A sample on a concave surface (an inside fillet) sits up to SAMPLE_SAG_MM outside the solid,
    # so its ray first crosses the real surface almost at once: that crossing is the entry into the
    # material, and the wall is measured from there to the exit.
    entry = SAMPLE_SAG_MM * 1.6
    limit = min_wall * 1.5 + entry
    thin: list[tuple[float, np.ndarray]] = []
    for p, nv in zip(pts, nrm):
        o = p - nv * eps
        inter.Perform(gp_Lin(gp_Pnt(*o), gp_Dir(*(-nv))), 1e-6, limit)
        ws = sorted(inter.WParameter(k) for k in range(1, inter.NbPnt() + 1))
        if not ws:
            continue
        if ws[0] < entry:
            if len(ws) < 2:
                continue
            thickness = ws[1] - ws[0]
        else:
            thickness = ws[0] + eps
        if thickness < min_wall - 0.02:
            thin.append((thickness, p - nv * (thickness / 2)))  # the middle of the wall

    if not thin:
        return []
    # Group thin spots into connected regions (a whole thin wall is one region), thinnest first.
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree

    where_all = np.array([w for _, w in thin])
    thick_all = np.array([tk for tk, _ in thin])
    pairs = cKDTree(where_all).query_pairs(r=2.5 * spacing, output_type="ndarray")
    from scipy.sparse import coo_matrix

    graph = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(thin), len(thin))) if len(pairs) else coo_matrix((len(thin), len(thin)))
    _, labels = connected_components(graph, directed=False)
    regions = []
    for lab in np.unique(labels):
        idx = np.flatnonzero(labels == lab)
        k = idx[np.argmin(thick_all[idx])]
        extent = np.sort(where_all[idx].max(axis=0) - where_all[idx].min(axis=0))[::-1]
        regions.append({"thickness": float(thick_all[k]), "where": where_all[k], "extent": extent, "count": len(idx)})
    regions.sort(key=lambda r: (r["thickness"], -r["count"]))
    problems = []
    for r in regions[:MAX_REGIONS_PER_BODY]:
        x, y, z = (round(float(q), 2) for q in r["where"])
        tk = r["thickness"]
        a, b2 = r["extent"][0], r["extent"][1]
        area = f" over about {a:.0f} x {b2:.0f} mm" if a >= 2 else ""
        if tk < nozzle and a >= SLIVER_MAX_MM:
            sev, extra = "error", f"thinner than the {nozzle:g} mm nozzle, so this wall will not print"
        elif tk < nozzle:
            # A small sliver (where two curves meet, say) is simply dropped by the slicer.
            sev, extra = "warning", f"a small sliver thinner than the {nozzle:g} mm nozzle; the slicer will leave it out"
        else:
            sev, extra = "warning", f"min {min_wall:g} mm"
        # The location goes in `location`; the CLI and the app add "near (x, y, z)" themselves.
        problems.append(Problem(sev, "thin_wall", f"Thin wall: {name}, {_fmt(tk)} mm{area} ({extra})",
                                body=name, location=[x, y, z]))
    if len(regions) > MAX_REGIONS_PER_BODY:
        problems.append(Problem("warning", "thin_wall", f"Thin wall: {name} has {len(regions) - MAX_REGIONS_PER_BODY} more thin regions",
                                body=name))
    return problems


# ------------------------------------------------------------------ small features


def small_features(name: str, body: Body, nozzle: float) -> list[Problem]:
    """Holes narrower than two nozzle widths may close up; pins that thin may not print."""
    from .topology import describe, mesh_faces

    _, _, _, _, centroids = mesh_faces(body.shape, 0.005, 0.4)
    topo = describe(name, body.shape, centroids)
    limit = 2 * nozzle
    problems = []
    for h in topo["features"]:
        if h["diameter"] < limit:
            x, y, z = h["center"]
            problems.append(Problem("warning", "small_feature",
                                    f"Small hole: {name}, Ø{h['diameter']:g} mm, may close up when printed (under {limit:g} mm)",
                                    body=name, location=[x, y, z]))
    for f in topo["faces"]:
        if f["type"] == "cylinder" and f.get("concave") is False and f.get("radius", 99) * 2 < limit:
            x, y, z = f["center"]
            problems.append(Problem("warning", "small_feature",
                                    f"Thin pin: {name}, Ø{2 * f['radius']:g} mm, may not print (under {limit:g} mm)",
                                    body=name, location=[x, y, z]))
    return problems


# ------------------------------------------------------------------ renders

RENDER_W, RENDER_H, SS = 800, 600, 2  # output size and supersampling factor
BACKGROUND = (244, 245, 247)
EDGE = np.array([42, 46, 54], dtype=np.float64)
SECTION = np.array([232, 93, 74], dtype=np.float64)

VIEWS = {
    # name: (direction from the model towards the camera, screen-up vector)
    "iso": ((1.0, -1.0, 0.85), (0.0, 0.0, 1.0)),
    "top": ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0)),
    "front": ((0.0, -1.0, 0.0), (0.0, 0.0, 1.0)),
    "right": ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
}


def _rgb(color: str) -> np.ndarray:
    c = color.lstrip("#")
    return np.array([int(c[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64)


def _write_png(path: Path, img: np.ndarray) -> None:
    h, w, _ = img.shape
    raw = b"".join(b"\x00" + img[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


class _Scene:
    """Triangles and edge polylines of all bodies, ready to draw from any direction."""

    def __init__(self):
        self.tris: list[np.ndarray] = []  # each Mx3x3
        self.colors: list[np.ndarray] = []  # each Mx3
        self.lines: list[np.ndarray] = []  # each Kx3 polyline

    def add(self, shape, color: np.ndarray, section_plane: tuple[np.ndarray, float] | None = None):
        from .topology import describe, mesh_faces

        mesh = mesh_faces(shape, 0.004, 0.35)
        v = np.asarray(mesh[0], dtype=np.float64).reshape(-1, 3)
        t = np.asarray(mesh[2], dtype=np.int64).reshape(-1, 3)
        if not len(t):
            return
        tris = v[t]
        cols = np.repeat(color[None, :], len(t), axis=0)
        if section_plane is not None:  # colour the cut faces
            n, d = section_plane
            cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
            norm = np.linalg.norm(cross, axis=1)
            unit = cross / np.maximum(norm, 1e-12)[:, None]
            on_plane = np.abs(tris.mean(axis=1) @ n - d) < 1e-3
            facing = unit @ n < -0.999
            cols[on_plane & facing] = SECTION
        self.tris.append(tris)
        self.colors.append(cols)
        for e in describe("", shape, mesh[4])["edges"]:
            self.lines.append(np.asarray(e["points"], dtype=np.float64))

    def bounds(self):
        allv = np.concatenate([x.reshape(-1, 3) for x in self.tris])
        return allv.min(axis=0), allv.max(axis=0)

    def render(self, direction, up) -> np.ndarray:
        W, H = RENDER_W * SS, RENDER_H * SS
        d = np.asarray(direction, dtype=np.float64)
        d /= np.linalg.norm(d)
        right = np.cross(np.asarray(up, dtype=np.float64), d)
        right /= np.linalg.norm(right)
        upv = np.cross(d, right)
        lo, hi = self.bounds()
        center = (lo + hi) / 2
        corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]) - center
        half_w = np.abs(corners @ right).max() * 1.12 + 1e-6
        half_h = np.abs(corners @ upv).max() * 1.12 + 1e-6
        scale = min(W / (2 * half_w), H / (2 * half_h))

        def project(p):
            q = p - center
            return np.stack([W / 2 + (q @ right) * scale, H / 2 - (q @ upv) * scale, q @ d], axis=-1)

        img = np.empty((H, W, 3), dtype=np.float64)
        img[:] = BACKGROUND
        zbuf = np.full((H, W), -np.inf)
        light = d + 0.35 * upv + 0.2 * right
        light /= np.linalg.norm(light)
        for tris, cols in zip(self.tris, self.colors):
            cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
            unit = cross / np.maximum(np.linalg.norm(cross, axis=1), 1e-12)[:, None]
            shade = 0.38 + 0.62 * np.abs(unit @ light)
            shaded = np.clip(cols * shade[:, None], 0, 255)
            pt = project(tris)  # Mx3x3 (x, y, depth)
            for k in range(len(pt)):
                (x0, y0, z0), (x1, y1, z1), (x2, y2, z2) = pt[k]
                minx, maxx = max(int(math.floor(min(x0, x1, x2))), 0), min(int(math.ceil(max(x0, x1, x2))), W - 1)
                miny, maxy = max(int(math.floor(min(y0, y1, y2))), 0), min(int(math.ceil(max(y0, y1, y2))), H - 1)
                if minx > maxx or miny > maxy:
                    continue
                den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
                if abs(den) < 1e-12:
                    continue
                xs = np.arange(minx, maxx + 1) + 0.5
                ys = np.arange(miny, maxy + 1) + 0.5
                gx, gy = np.meshgrid(xs, ys)
                w0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / den
                w1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / den
                w2 = 1 - w0 - w1
                inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
                if not inside.any():
                    continue
                z = w0 * z0 + w1 * z1 + w2 * z2
                zb = zbuf[miny : maxy + 1, minx : maxx + 1]
                win = inside & (z > zb)
                zb[win] = z[win]
                img[miny : maxy + 1, minx : maxx + 1][win] = shaded[k]
        # CAD edges, hidden where something covers them. All segments are sampled at once: about
        # one point per 0.7 px along each, then drawn 2 px wide (1 px after downsampling).
        tol = 0.004 * (2 * max(half_w, half_h))
        if self.lines:
            segs = np.concatenate([np.stack([pl[:-1], pl[1:]], axis=1) for pl in self.lines if len(pl) > 1])
            pa, pb = project(segs[:, 0]), project(segs[:, 1])
            steps = (np.maximum(np.abs(pb[:, 0] - pa[:, 0]), np.abs(pb[:, 1] - pa[:, 1])) / 0.7).astype(int) + 2
            seg_of = np.repeat(np.arange(len(segs)), steps)
            start = np.repeat(np.cumsum(steps) - steps, steps)
            ts = (np.arange(steps.sum()) - start) / np.repeat(steps - 1, steps)
            pts = pa[seg_of] + (pb[seg_of] - pa[seg_of]) * ts[:, None]
            for ox, oy in ((0, 0), (1, 0), (0, 1), (1, 1)):
                xi = np.clip((pts[:, 0] + ox).astype(int), 0, W - 1)
                yi = np.clip((pts[:, 1] + oy).astype(int), 0, H - 1)
                vis = pts[:, 2] >= zbuf[yi, xi] - tol
                img[yi[vis], xi[vis]] = EDGE
        # Downsample: average each SSxSS block (antialiasing).
        out = img.reshape(RENDER_H, SS, RENDER_W, SS, 3).mean(axis=(1, 3))
        return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def write_renders(bodies: dict[str, Body], out_dir: Path) -> list[Path]:
    """iso, top, front and right views of all bodies, plus a front section through the middle."""
    from build123d import Box, Pos

    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.png"):
        old.unlink()
    if not bodies:
        return []
    scene = _Scene()
    for b in bodies.values():
        scene.add(b.shape, _rgb(b.color or DEFAULT_COLOR))
    files = []
    for view, (direction, up) in VIEWS.items():
        path = out_dir / f"{view}.png"
        _write_png(path, scene.render(direction, up))
        files.append(path)

    # Section: keep the half behind the XZ plane through the middle, seen from the front.
    lo, hi = scene.bounds()
    cy = float((lo[1] + hi[1]) / 2)
    size = float(np.max(hi - lo)) * 4 + 10
    keep = Pos(float((lo[0] + hi[0]) / 2), cy + size / 2, float((lo[2] + hi[2]) / 2)) * Box(size, size, size)
    section = _Scene()
    plane = (np.array([0.0, 1.0, 0.0]), cy)
    for b in bodies.values():
        try:
            half = b.shape & keep
        except Exception:  # noqa: BLE001 - a failed cut just leaves this body out of the section
            continue
        if half is not None and half.volume > 1e-6:
            section.add(half, _rgb(b.color or DEFAULT_COLOR), section_plane=plane)
    if section.tris:
        path = out_dir / "section.png"
        _write_png(path, section.render(*VIEWS["front"]))
        files.append(path)
    return files


# ------------------------------------------------------------------ entry point


def full_checks(project, bodies: dict[str, Body]) -> tuple[list[Problem], list[Path], dict[str, float]]:
    settings = check_settings(project)
    problems: list[Problem] = []
    for name, body in bodies.items():
        problems += thin_walls(name, body, settings["min_wall_mm"], settings["nozzle_mm"])
        problems += small_features(name, body, settings["nozzle_mm"])
    renders = write_renders(bodies, project.cad_dir / "renders")
    return problems, renders, settings
