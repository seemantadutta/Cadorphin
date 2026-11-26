from build123d import *

from cadkit import Body


def build(p):
    part = Box(p.size, p.size, p.size, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return {"part": Body(part, color="#4C8BF5")}
