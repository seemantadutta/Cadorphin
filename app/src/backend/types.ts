/**
 * The only way UI code talks to the outside world. Implemented by TauriBackend (desktop) and
 * MockBackend (tests, and running the UI in a plain browser); a WebSocketBackend can be added later
 * for a browser version. Message shapes mirror cadkit's JSON output (docs/cadkit-cli.md).
 */

export type Unsubscribe = () => void;
export type TerminalId = string;

export interface ParamSpec {
  name: string;
  value: number | string | boolean;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  group?: string;
}

/** Output of `cadkit info --json`. */
export interface ProjectInfo {
  root: string;
  name: string;
  units: string;
  profile: { id: string; name: string; build_volume_mm: [number, number, number]; plate_mm: [number, number] };
  params: ParamSpec[];
  params_error: string | null;
  files: string[];
}

/** First line of `cadkit serve`: versions of the running engine. */
export interface EngineInfo {
  cadkit: string;
  build123d: string;
  python?: string;
  startup_ms?: number;
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

/** Output of `cadkit build --json` (also written to .cad/manifest.json). */
export interface BuildManifest {
  ok: boolean;
  exit_code: number;
  duration_ms?: number;
  script_ms?: number;
  bodies: BodyInfo[];
  problems: Problem[];
  errors: string[];
  notes?: string[];
  log?: string;
  timeout?: boolean;
}

/** Output of `cadkit check --json`. */
export interface CheckReport {
  ok: boolean;
  exit_code: number;
  duration_ms?: number;
  script_ms?: number;
  bodies: BodyInfo[];
  problems: Problem[];
  errors: string[];
  notes: string[];
  log?: string;
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
  /** Starts the CAD engine if needed. Rejects with a setup message if Python/cadkit is missing. */
  engineInfo(): Promise<EngineInfo>;
  /** Project requested at launch (command line or environment), if any. */
  initialProject(): Promise<string | null>;
  /** Asks the user for a folder. Resolves to null if they cancel. */
  pickProjectFolder(): Promise<string | null>;
  openProject(path: string): Promise<ProjectInfo>;
  /** Re-reads the open project's info (parameters, files) after a change. */
  projectInfo(): Promise<ProjectInfo>;
  onFileChanged(cb: (paths: string[]) => void): Unsubscribe;
  build(): Promise<BuildManifest>;
  check(level: "fast" | "full"): Promise<CheckReport>;
  export(format: "step" | "stl" | "3mf", outDir?: string): Promise<ExportResult>;
  readFile(path: string): Promise<string>;
  writeParams(values: Record<string, ParamValue>): Promise<void>;
  openTerminal(opts: { cwd: string; command?: string }): Promise<TerminalId>;
  writeTerminal(id: TerminalId, data: string): void;
  resizeTerminal(id: TerminalId, cols: number, rows: number): void;
  onTerminalData(id: TerminalId, cb: (data: string) => void): Unsubscribe;
  closeTerminal(id: TerminalId): Promise<void>;
  /** GLB files and renders, as raw bytes. Paths are relative to the project folder. */
  loadAsset(path: string): Promise<ArrayBuffer>;
}

export class NotYetImplemented extends Error {
  constructor(feature: string, milestone: string) {
    super(`${feature} arrives in ${milestone}`);
  }
}
