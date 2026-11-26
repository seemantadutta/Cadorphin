"""Two-part electronics enclosure: case with M2.5 heat-set insert bosses and a USB-C cutout,
a lid with a locating lip, and a separate clear light pipe.

The model is shown assembled. The lid rests on the case rim at z = height.
"""

from build123d import *

from cadkit import Body

BOTTOM = (Align.CENTER, Align.CENTER, Align.MIN)


def rounded_block(length, width, radius, height, z0=0.0):
    """Rounded-corner block, centred in XY, from z0 up by height."""
    radius = max(min(radius, min(length, width) / 2 - 0.01), 0.01)
    return Pos(0, 0, z0) * extrude(RectangleRounded(length, width, radius), height)


def boss_centers(p):
    # Bosses sit in the corners and sink 0.5 mm into the walls so they fuse with them.
    inset = p.wall + p.boss_diameter / 2 - 0.5
    x, y = p.length / 2 - inset, p.width / 2 - inset
    return [(sx * x, sy * y) for sx in (-1, 1) for sy in (-1, 1)]


def make_case(p):
    case = rounded_block(p.length, p.width, p.corner_radius, p.height)
    case -= rounded_block(
        p.length - 2 * p.wall, p.width - 2 * p.wall, p.corner_radius - p.wall, p.height, z0=p.floor
    )

    for x, y in boss_centers(p):
        case += Pos(x, y, p.floor) * Cylinder(p.boss_diameter / 2, p.height - p.floor, align=BOTTOM)
        # Pilot hole for a melted-in M2.5 insert, open at the top of the boss
        case -= Pos(x, y, p.height - p.insert_depth) * Cylinder(
            p.insert_pilot_diameter / 2, p.insert_depth + 1, align=BOTTOM
        )

    # USB-C port through the -X end wall
    slot = Plane.YZ.offset(-p.length / 2 + p.wall / 2) * SlotOverall(p.usbc_width, p.usbc_height)
    case -= Pos(0, 0, p.floor + p.usbc_center_z) * extrude(slot, amount=p.wall * 2, both=True)
    return case


def make_lid(p):
    c = p.fit_clearance
    lid = rounded_block(p.length, p.width, p.corner_radius, p.lid_thickness, z0=p.height)

    # Locating lip that drops into the case opening, notched around the bosses
    lip_l = p.length - 2 * (p.wall + c)
    lip_w = p.width - 2 * (p.wall + c)
    lip_r = p.corner_radius - p.wall - c
    z_lip = p.height - p.lip_height
    lip = rounded_block(lip_l, lip_w, lip_r, p.lip_height, z0=z_lip)
    lip -= rounded_block(lip_l - 2 * p.lip_wall, lip_w - 2 * p.lip_wall, lip_r - p.lip_wall, p.lip_height + 2, z0=z_lip - 1)
    for x, y in boss_centers(p):
        lip -= Pos(x, y, z_lip - 1) * Cylinder(p.boss_diameter / 2 + c, p.lip_height + 2, align=BOTTOM)
    lid += lip

    through = p.lip_height + p.lid_thickness + 2
    for x, y in boss_centers(p):
        lid -= Pos(x, y, z_lip - 1) * Cylinder(p.screw_clearance / 2, through, align=BOTTOM)
    lid -= Pos(p.light_pipe_x, p.light_pipe_y, p.height - 1) * Cylinder(
        p.light_pipe_diameter / 2 + c, p.lid_thickness + 2, align=BOTTOM
    )
    return lid


def make_light_pipe(p):
    # The flange sits under the lid and stops the pipe from falling out
    z0 = p.height - p.light_pipe_flange_thickness
    at = Pos(p.light_pipe_x, p.light_pipe_y, z0)
    flange = at * Cylinder(p.light_pipe_flange_diameter / 2, p.light_pipe_flange_thickness, align=BOTTOM)
    shaft_len = p.light_pipe_flange_thickness + p.lid_thickness + p.light_pipe_protrusion
    shaft = at * Cylinder(p.light_pipe_diameter / 2, shaft_len, align=BOTTOM)
    return flange + shaft


def build(p):
    return {
        "case": Body(make_case(p), material="PETG", color="#3A3F4A"),
        "lid": Body(make_lid(p), material="PETG", color="#5B6475"),
        "light_pipe": Body(make_light_pipe(p), material="Clear PETG", color="#CFEFF7"),
    }
