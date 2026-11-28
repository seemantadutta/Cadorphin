import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  Backend,
  BuildManifest,
  CheckReport,
  EngineInfo,
  ExportResult,
  MenuId,
  NewProjectOptions,
  ParamValue,
  PrinterProfile,
  ProjectTemplate,
  ProjectInfo,
  SetParamsResult,
  StartupProject,
  TerminalId,
  Unsubscribe,
} from "./types";

/**
 * Routes one app-wide Tauri event to per-terminal subscribers. Events for a terminal that has no
 * subscriber yet (output that arrives before openTerminal() resolves) are buffered and replayed.
 */
class TerminalEvents<T> {
  private subs = new Map<TerminalId, (payload: T) => void>();
  private pending = new Map<TerminalId, T[]>();

  constructor(event: string, pick: (raw: { id: string } & Record<string, unknown>) => T) {
    void listen<{ id: string } & Record<string, unknown>>(event, (e) => {
      const value = pick(e.payload);
      const cb = this.subs.get(e.payload.id);
      if (cb) cb(value);
      else this.pending.set(e.payload.id, [...(this.pending.get(e.payload.id) ?? []), value]);
    });
  }

  subscribe(id: TerminalId, cb: (payload: T) => void): Unsubscribe {
    this.subs.set(id, cb);
    this.pending.get(id)?.forEach(cb);
    this.pending.delete(id);
    return () => {
      if (this.subs.get(id) === cb) this.subs.delete(id);
    };
  }
}

/** listen() resolves asynchronously; this returns a synchronous unsubscribe that is safe to call early. */
function subscribe<T>(event: string, cb: (payload: T) => void): Unsubscribe {
  let stop: (() => void) | null = null;
  let cancelled = false;
  void listen<T>(event, (e) => cb(e.payload)).then((un) => {
    if (cancelled) un();
    else stop = un;
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}

/** Desktop backend: Tauri commands implemented in app/src-tauri/src/lib.rs. */
export class TauriBackend implements Backend {
  private termData = new TerminalEvents<string>("terminal-data", (p) => p.data as string);
  private termExit = new TerminalEvents<number | null>("terminal-exit", (p) => (p.code as number | null) ?? null);

  engineInfo() {
    return invoke<EngineInfo>("engine_info");
  }

  initialProject() {
    return invoke<StartupProject>("initial_project");
  }

  async pickFolder(title: string, defaultPath?: string) {
    const picked = await open({ directory: true, multiple: false, title, defaultPath });
    return typeof picked === "string" ? picked : null;
  }

  closeProject() {
    return invoke<void>("close_project");
  }

  claudeSessions(cwd: string) {
    return invoke<string[]>("claude_sessions", { cwd });
  }

  listTemplates() {
    return invoke<ProjectTemplate[]>("list_templates");
  }

  createProject(opts: NewProjectOptions) {
    return invoke<string>("create_project", { ...opts, description: opts.description?.trim() || null });
  }

  openProject(path: string) {
    return invoke<ProjectInfo>("open_project", { path });
  }

  projectInfo() {
    return invoke<ProjectInfo>("project_info");
  }

  onFileChanged(cb: (paths: string[]) => void): Unsubscribe {
    return subscribe<string[]>("files-changed", cb);
  }

  onMenu(cb: (id: MenuId) => void): Unsubscribe {
    return subscribe<MenuId>("menu", cb);
  }

  appVersion() {
    return getVersion();
  }

  listProfiles() {
    return invoke<PrinterProfile[]>("list_profiles");
  }

  setProfile(id: string) {
    return invoke<PrinterProfile>("set_profile", { profile: id });
  }

  build() {
    return invoke<BuildManifest>("build");
  }

  check(level: "fast" | "full") {
    return invoke<CheckReport>("check", { level });
  }

  export(format: "step" | "stl" | "3mf", outDir?: string, force?: boolean, bodies?: string[]) {
    return invoke<ExportResult>("export", { format, outDir: outDir ?? null, force: force ?? false, bodies: bodies ?? null });
  }

  async revealFolder(path: string) {
    await invoke("reveal_folder", { path });
  }

  readFile(path: string) {
    return invoke<string>("read_file", { path });
  }

  loadAsset(path: string) {
    return invoke<ArrayBuffer>("load_asset", { path });
  }

  async writeSelection(json: string | null, png?: Uint8Array) {
    await invoke("write_selection", { json, png: png ? Array.from(png) : null });
  }

  writeParams(values: Record<string, ParamValue>) {
    return invoke<SetParamsResult>("write_params", { values });
  }

  openTerminal(opts: { cwd?: string; command?: string; cols: number; rows: number }) {
    return invoke<TerminalId>("open_terminal", { cwd: opts.cwd ?? null, command: opts.command ?? null, cols: opts.cols, rows: opts.rows });
  }

  writeTerminal(id: TerminalId, data: string) {
    void invoke("write_terminal", { id, data }).catch(() => {});
  }

  resizeTerminal(id: TerminalId, cols: number, rows: number) {
    void invoke("resize_terminal", { id, cols, rows }).catch(() => {});
  }

  onTerminalData(id: TerminalId, cb: (data: string) => void) {
    return this.termData.subscribe(id, cb);
  }

  onTerminalExit(id: TerminalId, cb: (code: number | null) => void) {
    return this.termExit.subscribe(id, cb);
  }

  async closeTerminal(id: TerminalId) {
    await invoke("close_terminal", { id });
  }
}
