/**
 * cadkit's <body>.topo.json (cadkit/topology.py) and plain-language descriptions of what the user
 * picked. Ids are only valid for one build; the agent gets geometry, never ids.
 */

export type Vec3 = [number, number, number];

export interface TopoFace {
  id: number;
  type: string; // plane, cylinder, cone, sphere, torus, bspline, ...
  area: number;
  center: Vec3;
  point?: Vec3; // a point on the face
  normal?: Vec3;
  bbox: [Vec3, Vec3];
  radius?: number;
  axis?: { point: Vec3; dir: Vec3 };
  concave?: boolean;
  half_angle_deg?: number;
  major_radius?: number;
  minor_radius?: number;
}

export interface TopoEdge {
  id: number;
  type: string; // line, circle, ellipse, bspline, ...
  length: number;
  start: Vec3;
  end: Vec3;
  mid: Vec3;
  faces: number[];
  points: Vec3[];
  radius?: number;
  center?: Vec3;
}

export interface TopoHole {
  kind: "hole";
  id: number;
  faces: number[];
  diameter: number;
  depth: number;
  axis_dir: Vec3;
  center: Vec3;
  group: number;
  group_size: number;
  group_centers: Vec3[];
}

export interface Topo {
  body: string;
  units: "mm";
  faces: TopoFace[];
  edges: TopoEdge[];
  features: TopoHole[];
}

export interface Pick {
  body: string;
  kind: "face" | "edge";
  id: number;
}

const n = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};
const pt = (p: Vec3) => `(${p.map(n).join(", ")})`;

/** "+Z", "-X", or "(0.71, 0, 0.71)" for directions off the main axes. */
export function dirText(d: Vec3): string {
  const names = ["X", "Y", "Z"];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(Math.abs(d[i]) - 1) < 1e-3) return (d[i] > 0 ? "+" : "-") + names[i];
  }
  return pt(d);
}

function axisText(d: Vec3): string {
  return dirText(d).replace(/^[+-]/, "");
}

export function holeOf(topo: Topo, faceId: number): TopoHole | undefined {
  return topo.features.find((f) => f.kind === "hole" && f.faces.includes(faceId));
}

function faceName(topo: Topo, f: TopoFace): string {
  const hole = holeOf(topo, f.id);
  if (hole) return `hole Ø${n(hole.diameter)} mm`;
  switch (f.type) {
    case "plane":
      return f.normal ? `flat face facing ${dirText(f.normal)}` : "flat face";
    case "cylinder":
      return `${f.concave ? "concave" : "convex"} cylindrical face R${n(f.radius ?? 0)} mm${f.axis ? ` (axis ${axisText(f.axis.dir)})` : ""}`;
    case "cone":
      return `conical face${f.half_angle_deg !== undefined ? ` (${n(f.half_angle_deg)}° half-angle)` : ""}`;
    case "sphere":
      return `spherical face R${n(f.radius ?? 0)} mm`;
    case "torus":
      return `toroidal face (fillet R${n(f.minor_radius ?? 0)} mm)`;
    default:
      return `${f.type} face`;
  }
}

/** One full sentence about a picked face or edge, for .cad/selection.json. */
export function describePick(topo: Topo, p: Pick): string {
  if (p.kind === "face") {
    const f = topo.faces.find((x) => x.id === p.id);
    if (!f) return `a face on ${p.body}`;
    const hole = holeOf(topo, f.id);
    if (hole) {
      const others =
        hole.group_size > 1 ? `, 1 of ${hole.group_size} identical holes at ${hole.group_centers.map((c) => pt(c)).join(", ")}` : "";
      return `Hole Ø${n(hole.diameter)} mm, ${n(hole.depth)} mm deep, axis ${axisText(hole.axis_dir)}, centred at ${pt(hole.center)} on ${p.body}${others}.`;
    }
    const where = f.type === "plane" && f.normal ? planeWhere(f) : `centred at ${pt(f.center)}`;
    return `${cap(faceName(topo, f))} on ${p.body}, ${where}, area ${n(f.area)} mm².`;
  }
  const e = topo.edges.find((x) => x.id === p.id);
  if (!e) return `an edge on ${p.body}`;
  const between = e.faces
    .map((id) => topo.faces.find((f) => f.id === id))
    .filter((f): f is TopoFace => !!f)
    .map((f) => faceName(topo, f));
  const shape =
    e.type === "line"
      ? `Straight edge, ${n(e.length)} mm, from ${pt(e.start)} to ${pt(e.end)}`
      : e.type === "circle" && e.radius !== undefined
        ? `${Math.abs(e.length - 2 * Math.PI * e.radius) < 0.01 ? "Circular" : "Arc"} edge R${n(e.radius)} mm${e.center ? ` around ${pt(e.center)}` : ""}, ${n(e.length)} mm long`
        : `Curved (${e.type}) edge, ${n(e.length)} mm, from ${pt(e.start)} to ${pt(e.end)}`;
  return `${shape} on ${p.body}${between.length === 2 ? `, between a ${between[0]} and a ${between[1]}` : ""}.`;
}

function planeWhere(f: TopoFace): string {
  const d = dirText(f.normal!);
  const axis = "XYZ".indexOf(d.slice(1));
  if (d.length === 2 && axis >= 0) return `at ${"xyz"[axis]} = ${n(f.center[axis])}, centred at ${pt(f.center)}`;
  return `centred at ${pt(f.center)}`;
}

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}

/** The short reference pasted into the agent's prompt. */
export function summarize(picks: Pick[], topos: Map<string, Topo>): string {
  if (!picks.length) return "";
  const bodies = [...new Set(picks.map((p) => p.body))];
  const on = bodies.length === 1 ? ` on ${bodies[0]}` : "";
  let what: string;
  if (picks.length === 1) {
    const p = picks[0];
    const topo = topos.get(p.body);
    what = topo ? shortPick(topo, p) : `a ${p.kind}${on}`;
  } else {
    const faces = picks.filter((p) => p.kind === "face").length;
    const edges = picks.length - faces;
    const parts = [faces && `${faces} face${faces === 1 ? "" : "s"}`, edges && `${edges} edge${edges === 1 ? "" : "s"}`].filter(Boolean);
    what = `${parts.join(" and ")}${on}`;
  }
  return `[Selected in the Cadorphin viewer: ${what}. Details: .cad/selection.json, picture: .cad/selection.png]`;
}

function shortPick(topo: Topo, p: Pick): string {
  if (p.kind === "face") {
    const f = topo.faces.find((x) => x.id === p.id);
    if (!f) return `a face on ${p.body}`;
    const hole = holeOf(topo, f.id);
    if (hole) return `hole Ø${n(hole.diameter)} mm at ${pt(hole.center)} on ${p.body}${hole.group_size > 1 ? `, 1 of ${hole.group_size} identical` : ""}`;
    return `${faceName(topo, f)} on ${p.body} at ${pt(f.center)}`;
  }
  const e = topo.edges.find((x) => x.id === p.id);
  if (!e) return `an edge on ${p.body}`;
  if (e.type === "line") return `straight edge ${n(e.length)} mm on ${p.body}, from ${pt(e.start)} to ${pt(e.end)}`;
  if (e.type === "circle" && e.radius !== undefined) return `circular edge R${n(e.radius)} mm on ${p.body}${e.center ? ` around ${pt(e.center)}` : ""}`;
  return `${e.type} edge ${n(e.length)} mm on ${p.body}`;
}

/** What goes in .cad/selection.json: geometry the agent can match against model.py. */
export function selectionFile(picks: Pick[], topos: Map<string, Topo>) {
  return {
    about:
      "What the user picked in the Cadorphin viewer. Units are mm, Z is up. Find the matching feature in model.py " +
      "(usually a parameter) instead of hard-coding these coordinates. Face and edge ids are only valid for the current build.",
    summary: summarize(picks, topos),
    picks: picks.map((p) => {
      const topo = topos.get(p.body);
      const base = { body: p.body, kind: p.kind, description: topo ? describePick(topo, p) : "" };
      if (!topo) return base;
      if (p.kind === "face") {
        const f = topo.faces.find((x) => x.id === p.id);
        const hole = holeOf(topo, p.id);
        return { ...base, face: f, ...(hole ? { hole: { ...hole, faces: undefined } } : {}) };
      }
      const e = topo.edges.find((x) => x.id === p.id);
      // The polyline is for drawing; the endpoints, length and neighbouring faces describe it.
      const neighbours = e?.faces.map((id) => topo.faces.find((f) => f.id === id));
      return { ...base, edge: e ? { ...e, points: undefined } : undefined, between_faces: neighbours };
    }),
  };
}
