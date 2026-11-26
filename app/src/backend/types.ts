/**
 * The only way UI code talks to the outside world. Implemented by TauriBackend (desktop, M2)
 * and MockBackend (tests, M2); a WebSocketBackend can be added later for a browser version.
 * Message shapes mirror cadkit's JSON output (docs/cadkit-cli.md) so they stay plain JSON.
 */

export type Unsubscribe = () => void;
export type TerminalId = string;

export interface ProjectInfo {
  root: string;
  name: string;
  profile: string;
  files: string[];
}

export interface Problem {
  severity: "error" | "warning";
  code: string;
  message: string;
  body?: string;
  bodies?: string[];
  location?: [number, number, number];
}

export interface BodyInfo {
  name: string;
  material: string | null;
  color: string | null;
  bbox: [number, number, number];
  bbox_min: [number, number, number];
  volume_mm3: number;
  valid: boolean;
  glb?: string;
}

/** Contents of .cad/manifest.json written by `cadkit build`. */
export interface BuildManifest {
  ok: boolean;
  duration_ms: number;
  bodies: BodyInfo[];
  problems: Problem[];
  errors: string[];
  profile: string | null;
}

/** Output of `cadkit check --json`. */
export interface CheckReport {
  ok: boolean;
  exit_code: number;
  duration_ms: number;
  script_ms?: number;
  bodies: BodyInfo[];
  problems: Problem[];
  errors: string[];
  notes: string[];
}

/** Output of `cadkit export --json`. */
export interface ExportResult {
  ok: boolean;
  exit_code: number;
  files: string[];
  problems: Problem[];
  errors: string[];
  notes: string[];
}

export type ParamValue = number | string | boolean;

export interface Backend {
  openProject(path: string): Promise<ProjectInfo>;
  onFileChanged(cb: (paths: string[]) => void): Unsubscribe;
  build(): Promise<BuildManifest>;
  check(level: "fast" | "full"): Promise<CheckReport>;
  export(format: "step" | "stl" | "3mf", outDir: string): Promise<ExportResult>;
  readFile(path: string): Promise<string>;
  writeParams(values: Record<string, ParamValue>): Promise<void>;
  openTerminal(opts: { cwd: string; command?: string }): Promise<TerminalId>;
  writeTerminal(id: TerminalId, data: string): void;
  resizeTerminal(id: TerminalId, cols: number, rows: number): void;
  onTerminalData(id: TerminalId, cb: (data: string) => void): Unsubscribe;
  closeTerminal(id: TerminalId): Promise<void>;
  /** GLB files and renders, as raw bytes. */
  loadAsset(path: string): Promise<ArrayBuffer>;
}
