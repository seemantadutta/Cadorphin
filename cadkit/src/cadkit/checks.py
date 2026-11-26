"""Model checks shared by the CLI and the GUI (through the CLI).

Fast checks (run after every rebuild): each body is a valid closed solid,
fits the printer's build volume, and no two bodies overlap.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .body import Body
from .project import Profile

OVERLAP_TOLERANCE_MM3 = 1e-3
FIT_TOLERANCE_MM = 1e-6


@dataclass
class Problem:
    severity: str  # "error" blocks export, "warning" does not
    code: str
    message: str
    body: str | None = None
    location: list[float] | None = None
    bodies: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"severity": self.severity, "code": self.code, "message": self.message}
        if self.body is not None:
            d["body"] = self.body
        if self.bodies:
            d["bodies"] = self.bodies
        if self.location is not None:
            d["location"] = [round(v, 3) for v in self.location]
        return d


def _bbox(shape: Any):
    return shape.bounding_box()


def _center(bb) -> list[float]:
    return [(bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2, (bb.min.Z + bb.max.Z) / 2]


def solid_problems(name: str, body: Body) -> list[Problem]:
    """Is this body a valid, closed solid with positive volume?"""
    from OCP.BRep import BRep_Tool

    shape = body.shape
    solids = shape.solids()
    if not solids:
        kind = type(shape).__name__
        return [
            Problem(
                "error",
                "not_solid",
                f"{name} is not a solid ({kind} with {len(shape.faces())} faces and no volume). "
                "Extrude or loft sketches into solids before returning them.",
                body=name,
            )
        ]
    problems = []
    if not shape.is_valid:
        problems.append(Problem("error", "invalid_solid", f"{name} has invalid geometry (OCCT shape check failed)", body=name))
    open_shells = [s for s in shape.shells() if not BRep_Tool.IsClosed_s(s.wrapped)]
    if open_shells:
        problems.append(
            Problem(
                "error",
                "open_shell",
                f"{name} is not watertight ({len(open_shells)} open shell{'s' if len(open_shells) > 1 else ''})",
                body=name,
                location=_center(_bbox(open_shells[0])),
            )
        )
    if shape.volume <= 0:
        problems.append(Problem("error", "invalid_solid", f"{name} has zero or negative volume", body=name))
    return problems


def fit_problems(name: str, body: Body, profile: Profile) -> list[Problem]:
    bb = _bbox(body.shape)
    size = [bb.size.X, bb.size.Y, bb.size.Z]
    vol = list(profile.build_volume_mm)
    if all(s <= v + FIT_TOLERANCE_MM for s, v in zip(size, vol)):
        return []
    fits_rotated = all(s <= v + FIT_TOLERANCE_MM for s, v in zip(sorted(size), sorted(vol)))
    hint = " It would fit if rotated." if fits_rotated else ""
    return [
        Problem(
            "error",
            "too_large",
            f"{name} is {size[0]:.1f} × {size[1]:.1f} × {size[2]:.1f} mm, larger than the "
            f"{vol[0]:g} × {vol[1]:g} × {vol[2]:g} mm build volume of {profile.name}.{hint}",
            body=name,
        )
    ]


def _boxes_touch(a, b) -> bool:
    return not (
        a.max.X <= b.min.X or b.max.X <= a.min.X
        or a.max.Y <= b.min.Y or b.max.Y <= a.min.Y
        or a.max.Z <= b.min.Z or b.max.Z <= a.min.Z
    )


def _as_shape(result: Any):
    """Boolean ops return None, a Shape, or a ShapeList of pieces; normalise to Shape | None."""
    if result is None:
        return None
    if isinstance(result, (list, tuple)):
        if not result:
            return None
        from build123d import Compound

        return Compound(list(result))
    return result


def overlap_problems(bodies: dict[str, Body], skip: set[str]) -> list[Problem]:
    names = [n for n in bodies if n not in skip]
    boxes = {n: _bbox(bodies[n].shape) for n in names}
    problems = []
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            if not _boxes_touch(boxes[a], boxes[b]):
                continue
            common = _as_shape(bodies[a].shape.intersect(bodies[b].shape))
            vol = common.volume if common is not None else 0.0
            if vol > OVERLAP_TOLERANCE_MM3:
                problems.append(
                    Problem(
                        "error",
                        "overlap",
                        f"{a} and {b} overlap by {vol:.1f} mm³",
                        body=a,
                        bodies=[a, b],
                        location=_center(_bbox(common)),
                    )
                )
    return problems


def fast_checks(bodies: dict[str, Body], profile: Profile) -> list[Problem]:
    problems: list[Problem] = []
    broken: set[str] = set()
    for name, body in bodies.items():
        sp = solid_problems(name, body)
        if sp:
            broken.add(name)
        problems += sp
    for name, body in bodies.items():
        if name not in broken:
            problems += fit_problems(name, body, profile)
    problems += overlap_problems(bodies, skip=broken)
    return problems
