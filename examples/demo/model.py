"""Demo: an open box with rounded corners. Small enough to read in a minute.

Open this folder in Cadorphin, change a value in the Parameters panel (or ask an agent to),
and watch the model rebuild.
"""

from build123d import *

from cadkit import Body


def build(p):
    outer = Box(p.length, p.width, p.height, align=(Align.CENTER, Align.CENTER, Align.MIN))
    outer = fillet(outer.edges().filter_by(Axis.Z), radius=p.corner_radius)
    box = offset(outer, amount=-p.wall, openings=outer.faces().sort_by(Axis.Z)[-1])
    return {"box": Body(box, color="#4C8BF5")}
