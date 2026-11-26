import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type ViewName = "iso" | "top" | "front" | "right";
export type Projection = "perspective" | "orthographic";
export type ControlsMode = "orbit" | "trackball";

export interface ViewerBody {
  name: string;
  color: string;
  glb: ArrayBuffer;
}

export interface ViewerTheme {
  background: string;
  grid: string;
  gridCenter: string;
  edge: string;
}

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
  private animation: { from: [THREE.Vector3, THREE.Vector3]; delta: THREE.Vector3; start: number } | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly gizmo: Gizmo;
  private hasFitted = false;

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
    this.scene.add(this.model, this.hemi, this.headlight, this.headlight.target);

    this.makeControls(new THREE.Vector3());
    this.gizmo = new Gizmo();
    this.applyTheme();

    this.renderer.domElement.addEventListener("dblclick", this.onDoubleClick);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("dblclick", this.onDoubleClick);
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
          // cadkit writes one primitive per B-rep face, so each mesh's boundary is a CAD edge.
          mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMaterial));
        }
      });
      root.visible = !this.hidden.has(body.name);
      this.model.add(root);
      this.bodies.set(body.name, { root, meshes });
    }
    this.updateGrid();
    if (!this.hasFitted && bodies.length) {
      this.setView("iso");
      this.hasFitted = true;
    }
    this.invalidate();
  }

  private clearBodies() {
    for (const { root } of this.bodies.values()) {
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
    if (b) b.root.visible = visible;
    this.invalidate();
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
    for (const { meshes } of this.bodies.values()) {
      for (const m of meshes) {
        const color = (m.material as THREE.MeshStandardMaterial).color;
        m.children.forEach((c) => {
          ((c as THREE.LineSegments).material as THREE.LineBasicMaterial).color.set(this.edgeColorFor("#" + color.getHexString()));
        });
      }
    }
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
    this.animation = {
      from: [this.target.clone(), this.camera.position.clone()],
      delta: hit.point.clone().sub(this.target),
      start: performance.now(),
    };
  };

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    if (this.animation) {
      const t = Math.min(1, (performance.now() - this.animation.start) / 220);
      const e = 1 - Math.pow(1 - t, 3);
      this.target.copy(this.animation.from[0]).addScaledVector(this.animation.delta, e);
      this.camera.position.copy(this.animation.from[1]).addScaledVector(this.animation.delta, e);
      if (t >= 1) this.animation = null;
      this.invalidate();
    }
    this.controls.update();
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
  };
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
