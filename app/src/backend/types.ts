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

/** A printer profile as `cadkit` summarises it (profiles/*.json). */
export interface PrinterProfile {
  id: string;
  name: string;
  /** Groups the printer list, e.g. "Bambu Lab" or "Generic". */
  vendor?: string | null;
  build_volume_mm: [number, number, number];
  plate_mm: [number, number];
}

/** Ids the native menu sends (app/src-tauri/src/lib.rs, build_menu). */
export type MenuId = "new" | "open" | "close" | "preferences" | "about";

/** A project template for `cadkit new` (templates/). */
export interface ProjectTemplate {
  id: string;
  description: string;
}

/** What to open at launch: `path` if given; else the last project, unless `restore` is false. */
export interface StartupProject {
  path: string | null;
  restore: boolean;
}

export interface NewProjectOptions {
  /** Folder the project folder is created in. */
  parent: string;
  /** Name of the new project folder (also the project's name). */
  name: string;
  template: string;
  profile: string;
  /** What the design is for. Added to CLAUDE.md, AGENTS.md and GEMINI.md as a "Design brief". */
  description?: string;
}

/** Output of `cadkit info --json`. */
export interface ProjectInfo {
  root: string;
  name: string;
  units: string;
  profile: PrinterProfile;
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

/** Output of `cadkit set --json`. */
export interface SetParamsResult {
  changed: Record<string, ParamValue>;
  warnings: string[];
}

export interface Backend {
  /** Starts the CAD engine if needed. Rejects with a setup message if Python/cadkit is missing. */
  engineInfo(): Promise<EngineInfo>;
  /** Project requested at launch (command line or environment), if any. */
  initialProject(): Promise<StartupProject>;
  /** Asks the user for a folder. Resolves to null if they cancel. */
  pickFolder(title: string, defaultPath?: string): Promise<string | null>;
  /** Opens a project folder and watches it. Rejects if the folder is not a cadkit project. */
  openProject(path: string): Promise<ProjectInfo>;
  /** Stops watching the open project. */
  closeProject(): Promise<void>;
  listTemplates(): Promise<ProjectTemplate[]>;
  /** Ids of the Claude Code sessions saved for this folder, newest first (`claude --resume <id>` works for each). */
  claudeSessions(cwd: string): Promise<string[]>;
  /** Creates a project from a template (`cadkit new`) and resolves to its path. Does not open it. */
  createProject(opts: NewProjectOptions): Promise<string>;
  /** Re-reads the open project's info (parameters, files) after a change. */
  projectInfo(): Promise<ProjectInfo>;
  onFileChanged(cb: (paths: string[]) => void): Unsubscribe;
  build(): Promise<BuildManifest>;
  check(level: "fast" | "full"): Promise<CheckReport>;
  export(format: "step" | "stl" | "3mf", outDir?: string): Promise<ExportResult>;
  readFile(path: string): Promise<string>;
  /** Changes values in params.toml (via `cadkit set`). The watcher then triggers a rebuild. */
  writeParams(values: Record<string, ParamValue>): Promise<SetParamsResult>;
  /** Bundled printer profiles plus the open project's own `profiles/` folder. */
  listProfiles(): Promise<PrinterProfile[]>;
  /** Sets the open project's printer (`profile` in project.toml). The watcher then refreshes and rebuilds. */
  setProfile(id: string): Promise<PrinterProfile>;
  /** Native menu clicks. Backends without a native menu never call `cb`. */
  onMenu(cb: (id: MenuId) => void): Unsubscribe;
  /** Cadorphin's own version. */
  appVersion(): Promise<string>;
  /**
   * Opens the user's shell in a PTY (default cwd: the project folder). `command`, if given, is typed
   * into the shell after it starts; the shell stays open when the command exits.
   */
  openTerminal(opts: { cwd?: string; command?: string; cols: number; rows: number }): Promise<TerminalId>;
  writeTerminal(id: TerminalId, data: string): void;
  resizeTerminal(id: TerminalId, cols: number, rows: number): void;
  /** Output may arrive before the subscription; it is buffered and replayed. */
  onTerminalData(id: TerminalId, cb: (data: string) => void): Unsubscribe;
  onTerminalExit(id: TerminalId, cb: (code: number | null) => void): Unsubscribe;
  closeTerminal(id: TerminalId): Promise<void>;
  /** GLB files and renders, as raw bytes. Paths are relative to the project folder. */
  loadAsset(path: string): Promise<ArrayBuffer>;
}

export class NotYetImplemented extends Error {
  constructor(feature: string, milestone: string) {
    super(`${feature} arrives in ${milestone}`);
  }
}
