"""L-shaped wall bracket with two screw holes and an optional gusset. A single-body example."""

from build123d import *

from cadkit import Body


def build(p):
    t, w, a = p.thickness, p.width, p.arm
    base = Box(a, w, t, align=(Align.MIN, Align.CENTER, Align.MIN))
    upright = Box(t, w, a, align=(Align.MIN, Align.CENTER, Align.MIN))
    bracket = base + upright

    if p.gusset:
        g = a * 0.5
        tri = Polygon((t, 0), (t + g, 0), (t, g), align=None)
        gusset = extrude(Plane.XZ * Pos(0, t) * tri, amount=t / 2, both=True)
        bracket += gusset

    if p.chamfer > 0:
        # Chamfer every edge before the holes are cut, so hole rims stay crisp.
        c = min(p.chamfer, t * 0.45)
        bracket = chamfer(bracket.edges(), c)

    for x in (a * 0.7,):
        bracket -= Pos(x, 0, 0) * Cylinder(p.hole_diameter / 2, t * 3)
    for z in (a * 0.7,):
        bracket -= Pos(0, 0, z) * Rot(0, 90, 0) * Cylinder(p.hole_diameter / 2, t * 3)

    return {"bracket": Body(bracket, color="#E0A030")}
