import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import type { Pick, Topo } from "./topo";

export type ViewName = "iso" | "top" | "front" | "right";
export type Projection = "perspective" | "orthographic";
export type ControlsMode = "orbit" | "trackball";

export interface ViewerBody {
  name: string;
  color: string;
  glb: ArrayBuffer;
  /** cadkit's face/edge description (<body>.topo.json). Without it the body can't be picked. */
  topo?: Topo;
}

export interface ViewerTheme {
  background: string;
  grid: string;
  gridCenter: string;
  edge: string;
  accent: string;
}

const PICK_PX = 7; // how close (CSS px) the cursor must be to an edge to pick it instead of the face
const CLICK_SLOP_PX = 4; // a press that moves further than this is a drag (rotate), not a click

const FOV = 35;
const UP = new THREE.Vector3(0, 0, 1); // CAD convention: Z is up, units are millimetres

/** Direction from the target towards the camera for each preset view. */
const VIEW_DIRS: Record<ViewName, THREE.Vector3> = {
  iso: new THREE.Vector3(1, -1, 0.85).normalize(),
  top: new THREE.Vector3(0, -1e-4, 1).normalize(), // a hair off the pole keeps +Y pointing up on screen
  front: new THREE.Vector3(0, -1, 0),
  right: new THREE.Vector3(1, 0, 0),
};

type Controls = OrbitControls | TrackballControls;

interface LoadedBody {
  root: THREE.Object3D;
  meshes: THREE.Mesh[];
  topo?: Topo;
  /** CAD edges drawn from topo, in world mm; segEdge[i] is the edge id of segment i. */
  edges?: { lines: THREE.LineSegments; segs: Float32Array; segEdge: Int32Array };
}

/**
 * Three.js viewer for cadkit GLB output. Framework-free so it can be tested and reused;
 * the React component in ViewerPane.tsx owns one instance.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly model = new THREE.Group();
  private readonly persp: THREE.PerspectiveCamera;
  private readonly ortho: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private controls!: Controls;
  private controlsMode: ControlsMode = "orbit";
  private orthoHalfHeight = 50;
  private readonly bodies = new Map<string, LoadedBody>();
  private readonly hidden = new Set<string>();
  private readonly headlight = new THREE.DirectionalLight(0xffffff, 1.6);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x404650, 1.1);
  private grid: THREE.GridHelper | null = null;
  private theme: ViewerTheme;
  private needsRender = true;
  private frame = 0;
  /** Camera glide: target and camera position from -> to. */
  private animation: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; start: number } | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly gizmo: Gizmo;
  private hasFitted = false;
  private readonly edgeLayer = new THREE.Group(); // CAD edges, world space (Z-up mm)
  private readonly highlightLayer = new THREE.Group();
  private readonly markerLayer = new THREE.Group(); // problem markers, world space
  private picks: Pick[] = [];
  private hover: Pick | null = null;
  private press: { x: number; y: number; box: boolean; moved: boolean } | null = null;
  private boxEl: HTMLDivElement | null = null;
  private hoverFrame = 0;
  /** Called whenever the selection changes (by the user, or cleared because the model rebuilt). */
  onSelectionChange: ((picks: Pick[]) => void) | null = null;

  constructor(private readonly container: HTMLElement, theme: ViewerTheme) {
    this.theme = theme;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    this.persp = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    for (const cam of [this.persp, this.ortho]) cam.up.copy(UP);
    this.camera = this.persp;
    this.persp.position.copy(VIEW_DIRS.iso).multiplyScalar(250);

    // cadkit's GLBs are in metres and rotated to glTF's Y-up; undo both so the scene is Z-up mm.
    this.model.rotation.x = Math.PI / 2;
    this.model.scale.setScalar(1000);
    this.scene.add(this.model, this.edgeLayer, this.highlightLayer, this.markerLayer, this.hemi, this.headlight, this.headlight.target);

    this.makeControls(new THREE.Vector3());
    this.gizmo = new Gizmo();
    this.applyTheme();

    this.renderer.domElement.addEventListener("dblclick", this.onDoubleClick);
    // Capture phase, so a Ctrl+drag box can switch the camera controls off before they see it.
    container.addEventListener("pointerdown", this.onPointerDown, true);
    container.addEventListener("pointermove", this.onPointerMove);
    container.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("pointerup", this.onPointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("dblclick", this.onDoubleClick);
    this.container.removeEventListener("pointerdown", this.onPointerDown, true);
    this.container.removeEventListener("pointermove", this.onPointerMove);
    this.container.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("pointerup", this.onPointerUp);
    cancelAnimationFrame(this.hoverFrame);
    this.controls.dispose();
    this.clearBodies();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------------------------------------------------------- bodies

  /** Replace all bodies. Parses everything first so the swap is atomic (no flicker). */
  async setBodies(bodies: ViewerBody[]) {
    const loader = new GLTFLoader();
    const parsed = await Promise.all(
      bodies.map(async (b) => {
        const gltf = await loader.parseAsync(b.glb.slice(0), "");
        return { body: b, root: gltf.scene };
      }),
    );
    this.clearBodies();
    for (const { body, root } of parsed) {
      const meshes: THREE.Mesh[] = [];
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(body.color),
        metalness: 0.05,
        roughness: 0.62,
        side: THREE.DoubleSide,
        polygonOffset: true, // keep the edge lines on top of the faces
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const edgeMaterial = new THREE.LineBasicMaterial({ color: this.edgeColorFor(body.color) });
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh;
          mesh.material = material;
          mesh.userData.body = body.name;
          meshes.push(mesh);
          // Without cadkit's edge list (older builds, the browser preview), guess edges from creases.
          if (!body.topo) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMaterial));
        }
      });
      root.visible = !this.hidden.has(body.name);
      this.model.add(root);
      const loaded: LoadedBody = { root, meshes, topo: body.topo };
      if (body.topo) {
        loaded.edges = buildEdges(body.topo, edgeMaterial);
        loaded.edges.lines.visible = root.visible;
        this.edgeLayer.add(loaded.edges.lines);
      }
      this.bodies.set(body.name, loaded);
    }
    // Face and edge ids belong to one build, so a rebuild clears the selection.
    this.hover = null;
    if (this.picks.length) {
      this.picks = [];
      this.onSelectionChange?.([]);
    }
    this.refreshHighlights();
    this.updateGrid();
    if (!this.hasFitted && bodies.length) {
      this.setView("iso");
      this.hasFitted = true;
    }
    this.invalidate();
  }

  private clearBodies() {
    for (const { root, edges } of this.bodies.values()) {
      if (edges) {
        this.edgeLayer.remove(edges.lines);
        edges.lines.geometry.dispose();
      }
      this.model.remove(root);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
    this.bodies.clear();
  }

  setVisible(name: string, visible: boolean) {
    if (visible) this.hidden.delete(name);
    else this.hidden.add(name);
    const b = this.bodies.get(name);
    if (b) {
      b.root.visible = visible;
      if (b.edges) b.edges.lines.visible = visible;
    }
    if (!visible && this.picks.some((p) => p.body === name)) {
      this.picks = this.picks.filter((p) => p.body !== name);
      this.onSelectionChange?.(this.picks);
    }
    this.refreshHighlights();
    this.invalidate();
  }

  // ---------------------------------------------------------------- problem markers

  /** Markers at problem locations (mm). They keep a fixed size on screen and show through the model. */
  setMarkers(markers: { location: [number, number, number]; severity: "error" | "warning"; active: boolean }[]) {
    for (const c of [...this.markerLayer.children]) {
      this.markerLayer.remove(c);
      ((c as THREE.Sprite).material as THREE.SpriteMaterial).dispose();
    }
    for (const m of markers) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: markerTexture(m.severity), depthTest: false, sizeAttenuation: false, transparent: true }),
      );
      sprite.position.set(...m.location);
      sprite.scale.setScalar(m.active ? 0.06 : 0.04);
      sprite.renderOrder = m.active ? 21 : 20;
      this.markerLayer.add(sprite);
    }
    this.invalidate();
  }

  /** Glide to a point and frame about `radius` mm around it (a problem's location). */
  focusOn(location: [number, number, number], radius = 20) {
    const target = new THREE.Vector3(...location);
    const dir = this.camera.position.clone().sub(this.target).normalize();
    const halfFov = THREE.MathUtils.degToRad(FOV / 2);
    let camera: THREE.Vector3;
    if (this.camera === this.persp) {
      camera = target.clone().addScaledVector(dir, radius / Math.sin(halfFov));
    } else {
      camera = target.clone().addScaledVector(dir, this.camera.position.distanceTo(this.target));
      this.ortho.zoom = this.orthoHalfHeight / radius;
      this.updateProjection();
    }
    this.animation = { from: [this.target.clone(), this.camera.position.clone()], to: [target, camera], start: performance.now() };
    this.invalidate();
  }

  // ---------------------------------------------------------------- selection (point-and-fix)

  get selection(): Pick[] {
    return this.picks;
  }

  clearSelection() {
    if (!this.picks.length) return;
    this.picks = [];
    this.refreshHighlights();
    this.onSelectionChange?.([]);
  }

  /** The current view as a PNG data URL, highlights included (for .cad/selection.png). */
  capture(): string {
    this.needsRender = true;
    this.renderFrame();
    return this.renderer.domElement.toDataURL("image/png");
  }

  private visibleBodies(): [string, LoadedBody][] {
    return [...this.bodies.entries()].filter(([, b]) => b.root.visible);
  }

  private ndcAt(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  /** World point (mm) to CSS pixels relative to the canvas. */
  private toScreen(v: THREE.Vector3, out: THREE.Vector2): THREE.Vector2 {
    const p = v.clone().project(this.camera);
    const { x: w, y: h } = this.renderer.getSize(new THREE.Vector2());
    return out.set(((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h);
  }

  /** First mesh hit along the ray through a screen point (NDC). */
  private castAt(ndc: THREE.Vector2): THREE.Intersection | undefined {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray.intersectObjects(
      this.visibleBodies().flatMap(([, b]) => b.meshes),
      false,
    )[0];
  }

  /** Whether a world point is the first thing seen along its line of sight (not hidden by a face). */
  private isVisible(point: THREE.Vector3): boolean {
    const ndc = point.clone().project(this.camera);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    const hit = ray.intersectObjects(this.visibleBodies().flatMap(([, b]) => b.meshes), false)[0];
    if (!hit) return true;
    const along = point.clone().sub(ray.ray.origin).dot(ray.ray.direction);
    return hit.distance >= along - Math.max(0.05, along * 0.002);
  }

  /** What is under the cursor: an edge within a few pixels, else the face, else nothing. */
  private pickAt(clientX: number, clientY: number): Pick | null {
    const ndc = this.ndcAt(clientX, clientY);
    const hit = this.castAt(ndc);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const cursor = new THREE.Vector2(clientX - rect.left, clientY - rect.top);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const sa = new THREE.Vector2();
    const sb = new THREE.Vector2();
    let best: { pick: Pick; d: number } | null = null;
    for (const [name, body] of this.visibleBodies()) {
      if (!body.edges) continue;
      const { segs, segEdge } = body.edges;
      for (let i = 0; i < segEdge.length; i++) {
        a.fromArray(segs, i * 6);
        b.fromArray(segs, i * 6 + 3);
        this.toScreen(a, sa);
        this.toScreen(b, sb);
        const t = segmentT(cursor, sa, sb);
        const d = cursor.distanceTo(sa.clone().lerp(sb, t));
        if (d > PICK_PX || (best && d >= best.d)) continue;
        const onEdge = a.clone().lerp(b, t);
        if (!this.isVisible(onEdge)) continue; // behind the model
        best = { pick: { body: name, kind: "edge", id: segEdge[i] }, d };
      }
    }
    if (best) return best.pick;
    if (!hit) return null;
    const mesh = hit.object as THREE.Mesh;
    const ids = mesh.geometry.getAttribute("_face_id");
    const body = mesh.userData.body as string;
    if (!ids || !hit.face || !this.bodies.get(body)?.topo) return null;
    return { body, kind: "face", id: Math.round(ids.getX(hit.face.a)) };
  }

  /** Box select: visible edges entirely inside the box; if there are none, visible faces. */
  private pickInBox(x0: number, y0: number, x1: number, y1: number): Pick[] {
    const [l, r, t, btm] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
    const rect = this.renderer.domElement.getBoundingClientRect();
    const inside = (v: THREE.Vector3) => {
      const s = this.toScreen(v, new THREE.Vector2());
      const x = s.x + rect.left;
      const y = s.y + rect.top;
      return x >= l && x <= r && y >= t && y <= btm;
    };
    const v = new THREE.Vector3();
    const edges: Pick[] = [];
    const faces: Pick[] = [];
    for (const [name, body] of this.visibleBodies()) {
      if (!body.topo) continue;
      for (const e of body.topo.edges) {
        if (e.points.every((p) => inside(v.fromArray(p))) && this.isVisible(v.fromArray(e.mid))) edges.push({ body: name, kind: "edge", id: e.id });
      }
      for (const f of body.topo.faces) {
        if (!f.point) continue;
        const [lo, hi] = f.bbox;
        const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]));
        if (corners.every((c) => inside(c)) && this.isVisible(v.fromArray(f.point))) faces.push({ body: name, kind: "face", id: f.id });
      }
    }
    return edges.length ? edges : faces;
  }

  private setPicks(next: Pick[]) {
    this.picks = next;
    this.refreshHighlights();
    this.onSelectionChange?.(next);
  }

  private refreshHighlights() {
    for (const c of [...this.highlightLayer.children]) {
      this.highlightLayer.remove(c);
      const o = c as THREE.Mesh;
      o.geometry?.dispose();
      (o.material as THREE.Material | undefined)?.dispose();
    }
    const accent = new THREE.Color(this.theme.accent || "#7dd3c0");
    const { x: w, y: h } = this.renderer.getSize(new THREE.Vector2());
    const add = (p: Pick, strong: boolean) => {
      const body = this.bodies.get(p.body);
      if (!body?.root.visible || !body.topo) return;
      if (p.kind === "edge") {
        const e = body.topo.edges.find((x) => x.id === p.id);
        if (!e) return;
        const pos: number[] = [];
        for (let i = 0; i + 1 < e.points.length; i++) pos.push(...e.points[i], ...e.points[i + 1]);
        const geo = new LineSegmentsGeometry().setPositions(pos);
        const mat = new LineMaterial({ color: accent, linewidth: strong ? 4 : 3, transparent: !strong, opacity: strong ? 1 : 0.6, depthTest: false });
        mat.resolution.set(w, h);
        const line = new LineSegments2(geo, mat);
        line.renderOrder = 10;
        this.highlightLayer.add(line);
        return;
      }
      for (const mesh of body.meshes) {
        const geo = faceGeometry(mesh, p.id);
        if (!geo) continue;
        const mat = new THREE.MeshBasicMaterial({
          color: accent,
          transparent: true,
          opacity: strong ? 0.55 : 0.3,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const overlay = new THREE.Mesh(geo, mat);
        overlay.renderOrder = 5;
        this.highlightLayer.add(overlay);
      }
    };
    for (const p of this.picks) add(p, true);
    if (this.hover && !this.picks.some((p) => samePick(p, this.hover!))) add(this.hover, false);
    this.invalidate();
  }

  private onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    const box = ev.ctrlKey || ev.metaKey;
    this.press = { x: ev.clientX, y: ev.clientY, box, moved: false };
    if (box) {
      this.controls.enabled = false; // the drag draws a box instead of panning
      this.boxEl = document.createElement("div");
      this.boxEl.className = "select-box";
      this.container.appendChild(this.boxEl);
      this.updateBox(ev.clientX, ev.clientY);
    }
  };

  private onPointerMove = (ev: PointerEvent) => {
    if (this.press) {
      if (Math.hypot(ev.clientX - this.press.x, ev.clientY - this.press.y) > CLICK_SLOP_PX) this.press.moved = true;
      if (this.press.box) this.updateBox(ev.clientX, ev.clientY);
      return;
    }
    if (ev.buttons) return; // rotating or panning
    const { clientX, clientY } = ev;
    cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = requestAnimationFrame(() => {
      const pick = this.pickAt(clientX, clientY);
      if (pick === this.hover || (pick && this.hover && samePick(pick, this.hover))) return;
      this.hover = pick;
      this.renderer.domElement.style.cursor = pick ? "pointer" : "";
      this.refreshHighlights();
    });
  };

  private onPointerLeave = () => {
    cancelAnimationFrame(this.hoverFrame);
    if (this.hover) {
      this.hover = null;
      this.renderer.domElement.style.cursor = "";
      this.refreshHighlights();
    }
  };

  private onPointerUp = (ev: PointerEvent) => {
    const press = this.press;
    this.press = null;
    if (!press || ev.button !== 0) return;
    if (press.box) {
      this.controls.enabled = true;
      this.boxEl?.remove();
      this.boxEl = null;
      if (!press.moved) return;
      const found = this.pickInBox(press.x, press.y, ev.clientX, ev.clientY);
      this.setPicks(ev.shiftKey ? mergePicks(this.picks, found) : found);
      return;
    }
    if (press.moved) return; // that was a rotate
    const pick = this.pickAt(ev.clientX, ev.clientY);
    if (ev.shiftKey) {
      if (!pick) return;
      const has = this.picks.some((p) => samePick(p, pick));
      this.setPicks(has ? this.picks.filter((p) => !samePick(p, pick)) : [...this.picks, pick]);
    } else {
      this.setPicks(pick ? [pick] : []);
    }
  };

  private updateBox(x: number, y: number) {
    if (!this.press || !this.boxEl) return;
    const rect = this.container.getBoundingClientRect();
    const l = Math.min(this.press.x, x) - rect.left;
    const t = Math.min(this.press.y, y) - rect.top;
    Object.assign(this.boxEl.style, {
      left: `${l}px`,
      top: `${t}px`,
      width: `${Math.abs(x - this.press.x)}px`,
      height: `${Math.abs(y - this.press.y)}px`,
    });
  }

  /** Bounding box of the visible bodies, in mm (world space), or null if nothing is shown. */
  visibleBox(): THREE.Box3 | null {
    const box = new THREE.Box3();
    this.model.updateMatrixWorld(true);
    for (const { root } of this.bodies.values()) if (root.visible) box.expandByObject(root);
    return box.isEmpty() ? null : box;
  }

  // ---------------------------------------------------------------- camera

  get projection(): Projection {
    return this.camera === this.persp ? "perspective" : "orthographic";
  }

  private get target(): THREE.Vector3 {
    return this.controls.target;
  }

  /** Switch projection keeping the view direction, target and apparent size (no jump). */
  setProjection(p: Projection) {
    if (p === this.projection) return;
    const target = this.target.clone();
    const dir = this.camera.position.clone().sub(target).normalize();
    const quat = this.camera.quaternion.clone();
    const halfFov = THREE.MathUtils.degToRad(FOV / 2);
    if (p === "orthographic") {
      const dist = this.persp.position.distanceTo(target);
      this.orthoHalfHeight = dist * Math.tan(halfFov);
      this.ortho.zoom = 1;
      this.ortho.position.copy(target).addScaledVector(dir, Math.max(dist, this.sceneRadius() * 4));
      this.ortho.quaternion.copy(quat);
      this.camera = this.ortho;
    } else {
      const halfH = this.orthoHalfHeight / this.ortho.zoom;
      const dist = halfH / Math.tan(halfFov);
      this.persp.position.copy(target).addScaledVector(dir, dist);
      this.persp.quaternion.copy(quat);
      this.camera = this.persp;
    }
    this.updateProjection();
    this.makeControls(target);
    this.invalidate();
  }

  setControlsMode(mode: ControlsMode) {
    if (mode === this.controlsMode) return;
    this.controlsMode = mode;
    this.makeControls(this.target.clone());
  }

  setView(view: ViewName) {
    const target = this.target.clone();
    const dir = VIEW_DIRS[view];
    const dist = this.camera.position.distanceTo(target);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.up.copy(UP); // trackball mode may have rolled the camera
    this.camera.lookAt(target);
    this.fit();
  }

  /** Frame the visible bodies (or everything) without changing the view direction. */
  fit() {
    const box = this.visibleBox() ?? new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1) * 1.12;
    const dir = this.camera.position.clone().sub(this.target).normalize();
    const aspect = this.aspect();
    const halfFov = THREE.MathUtils.degToRad(FOV / 2);
    const halfFovMin = aspect < 1 ? Math.atan(Math.tan(halfFov) * aspect) : halfFov;
    this.target.copy(sphere.center);
    if (this.camera === this.persp) {
      this.persp.position.copy(sphere.center).addScaledVector(dir, r / Math.sin(halfFovMin));
    } else {
      this.orthoHalfHeight = aspect < 1 ? r / aspect : r;
      this.ortho.zoom = 1;
      this.ortho.position.copy(sphere.center).addScaledVector(dir, r * 4);
      this.updateProjection();
    }
    this.camera.lookAt(sphere.center);
    this.controls.update();
    this.invalidate();
  }

  setTheme(theme: ViewerTheme) {
    this.theme = theme;
    this.applyTheme();
  }

  invalidate() {
    this.needsRender = true;
  }

  // ---------------------------------------------------------------- internals

  private makeControls(target: THREE.Vector3) {
    this.controls?.dispose();
    const dom = this.renderer.domElement;
    if (this.controlsMode === "orbit") {
      const c = new OrbitControls(this.camera, dom);
      c.zoomToCursor = true;
      c.screenSpacePanning = true;
      c.enableDamping = false;
      c.zoomSpeed = 1.2;
      // Left rotates (Shift/Ctrl+left pans), middle and right pan, wheel zooms toward the cursor.
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
      this.controls = c;
    } else {
      const c = new TrackballControls(this.camera, dom);
      c.rotateSpeed = 3;
      c.zoomSpeed = 1.2;
      c.panSpeed = 0.9;
      c.staticMoving = true;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
      this.controls = c;
    }
    this.controls.target.copy(target);
    this.controls.addEventListener("change", () => this.invalidate());
    this.controls.update();
    this.invalidate();
  }

  private aspect() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    return w / h;
  }

  private updateProjection() {
    const a = this.aspect();
    this.persp.aspect = a;
    this.persp.updateProjectionMatrix();
    this.ortho.left = -this.orthoHalfHeight * a;
    this.ortho.right = this.orthoHalfHeight * a;
    this.ortho.top = this.orthoHalfHeight;
    this.ortho.bottom = -this.orthoHalfHeight;
    this.ortho.updateProjectionMatrix();
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.updateProjection();
    if (this.controls instanceof TrackballControls) this.controls.handleResize();
    this.refreshHighlights(); // fat-line widths are in pixels and need the new size
    this.invalidate();
  }

  private sceneRadius() {
    const box = this.visibleBox();
    return box ? box.getBoundingSphere(new THREE.Sphere()).radius : 100;
  }

  private updateGrid() {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const box = this.visibleBox();
    const size = box ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y) : 100;
    const extent = Math.max(200, Math.ceil((size * 3) / 100) * 100);
    this.grid = new THREE.GridHelper(extent, extent / 10, this.theme.gridCenter, this.theme.grid);
    this.grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; CAD build plate is XY
    this.grid.position.z = box ? Math.min(0, box.min.z) - 0.01 : 0;
    this.scene.add(this.grid);
  }

  private applyTheme() {
    this.renderer.setClearColor(new THREE.Color(this.theme.background), 1);
    this.updateGrid();
    for (const { meshes, edges } of this.bodies.values()) {
      for (const m of meshes) {
        const color = (m.material as THREE.MeshStandardMaterial).color;
        const edgeColor = this.edgeColorFor("#" + color.getHexString());
        m.children.forEach((c) => ((c as THREE.LineSegments).material as THREE.LineBasicMaterial).color.set(edgeColor));
        if (edges) (edges.lines.material as THREE.LineBasicMaterial).color.set(edgeColor);
      }
    }
    this.refreshHighlights();
    this.invalidate();
  }

  private edgeColorFor(bodyColor: string): THREE.Color {
    // Edges a little darker than the body read as CAD edges on light and dark parts.
    const c = new THREE.Color(bodyColor);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    return new THREE.Color().setHSL(hsl.h, hsl.s * 0.6, hsl.l > 0.5 ? hsl.l * 0.55 : Math.max(0.04, hsl.l * 0.45));
  }

  private onDoubleClick = (ev: MouseEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const meshes = [...this.bodies.values()].filter((b) => b.root.visible).flatMap((b) => b.meshes);
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) return;
    // Glide so the clicked point becomes the orbit pivot at the centre of the view.
    const delta = hit.point.clone().sub(this.target);
    this.animation = {
      from: [this.target.clone(), this.camera.position.clone()],
      to: [hit.point.clone(), this.camera.position.clone().add(delta)],
      start: performance.now(),
    };
  };

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    if (this.animation) {
      const t = Math.min(1, (performance.now() - this.animation.start) / 220);
      const e = 1 - Math.pow(1 - t, 3);
      this.target.lerpVectors(this.animation.from[0], this.animation.to[0], e);
      this.camera.position.lerpVectors(this.animation.from[1], this.animation.to[1], e);
      if (t >= 1) this.animation = null;
      this.invalidate();
    }
    this.controls.update();
    this.renderFrame();
  };

  private renderFrame() {
    if (!this.needsRender) return;
    this.needsRender = false;
    this.headlight.position.copy(this.camera.position);
    this.headlight.target.position.copy(this.target);
    // setViewport/setScissor take CSS pixels; three applies the device pixel ratio itself.
    const { x: w, y: h } = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.gizmo.render(this.renderer, this.camera, this.target, w);
  }
}

function samePick(a: Pick, b: Pick) {
  return a.body === b.body && a.kind === b.kind && a.id === b.id;
}

function mergePicks(a: Pick[], b: Pick[]) {
  return [...a, ...b.filter((p) => !a.some((q) => samePick(p, q)))];
}

/** Position (0..1) along segment ab of the point nearest to p. */
function segmentT(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const len2 = ab.lengthSq();
  return len2 ? THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / len2, 0, 1) : 0;
}

/** CAD edges from cadkit's topology as one LineSegments object, in world mm. */
function buildEdges(topo: Topo, material: THREE.LineBasicMaterial) {
  const pos: number[] = [];
  const segEdge: number[] = [];
  for (const e of topo.edges) {
    for (let i = 0; i + 1 < e.points.length; i++) {
      pos.push(...e.points[i], ...e.points[i + 1]);
      segEdge.push(e.id);
    }
  }
  const segs = new Float32Array(pos);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(segs, 3));
  return { lines: new THREE.LineSegments(geo, material), segs, segEdge: Int32Array.from(segEdge) };
}

/** The triangles of one B-rep face (by cadkit's _FACE_ID vertex attribute), in world mm. */
function faceGeometry(mesh: THREE.Mesh, faceId: number): THREE.BufferGeometry | null {
  const g = mesh.geometry;
  const ids = g.getAttribute("_face_id");
  const posAttr = g.getAttribute("position");
  const index = g.getIndex();
  if (!ids || !posAttr || !index) return null;
  mesh.updateWorldMatrix(true, false);
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    if (Math.round(ids.getX(index.getX(i))) !== faceId) continue;
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(posAttr, index.getX(i + k)).applyMatrix4(mesh.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
  if (!out.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  return geo;
}

/** Small XYZ axis indicator in the bottom-right corner that turns with the view. */
class Gizmo {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);

  constructor() {
    const axes: [THREE.Vector3, string, string][] = [
      [new THREE.Vector3(1, 0, 0), "#F87171", "X"],
      [new THREE.Vector3(0, 1, 0), "#34D399", "Y"],
      [new THREE.Vector3(0, 0, 1), "#60A5FA", "Z"],
    ];
    for (const [dir, color, label] of axes) {
      this.scene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.28, 0.16));
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(label, color), depthTest: false }));
      sprite.position.copy(dir).multiplyScalar(1.35);
      sprite.scale.setScalar(0.5);
      this.scene.add(sprite);
    }
    this.camera.up.copy(UP);
  }

  render(renderer: THREE.WebGLRenderer, main: THREE.Camera, target: THREE.Vector3, w: number) {
    const size = 96; // CSS pixels
    this.camera.position.copy(main.position).sub(target).setLength(4);
    this.camera.quaternion.copy(main.quaternion);
    renderer.setViewport(w - size - 8, 8, size, size);
    renderer.setScissor(w - size - 8, 8, size, size);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }
}

const markerTextures = new Map<string, THREE.Texture>();

/** A round marker: red for errors, amber for warnings, with a white ring so it reads on any part. */
function markerTexture(severity: "error" | "warning"): THREE.Texture {
  const cached = markerTextures.get(severity);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.beginPath();
  g.arc(32, 32, 26, 0, Math.PI * 2);
  g.fillStyle = severity === "error" ? "#ef4444" : "#f59e0b";
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = "#ffffff";
  g.stroke();
  g.fillStyle = "#ffffff";
  g.font = "700 34px Inter, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("!", 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  markerTextures.set(severity, t);
  return t;
}

function labelTexture(text: string, color: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.font = "600 44px Inter, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
