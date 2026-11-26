import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  Backend,
  BuildManifest,
  CheckReport,
  EngineInfo,
  ExportResult,
  ParamValue,
  ProjectInfo,
  SetParamsResult,
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

/** Desktop backend: Tauri commands implemented in app/src-tauri/src/lib.rs. */
export class TauriBackend implements Backend {
  private termData = new TerminalEvents<string>("terminal-data", (p) => p.data as string);
  private termExit = new TerminalEvents<number | null>("terminal-exit", (p) => (p.code as number | null) ?? null);

  engineInfo() {
    return invoke<EngineInfo>("engine_info");
  }

  initialProject() {
    return invoke<string | null>("initial_project");
  }

  async pickProjectFolder() {
    const picked = await open({ directory: true, multiple: false, title: "Open a Cadorphin project folder" });
    return typeof picked === "string" ? picked : null;
  }

  openProject(path: string) {
    return invoke<ProjectInfo>("open_project", { path });
  }

  projectInfo() {
    return invoke<ProjectInfo>("project_info");
  }

  onFileChanged(cb: (paths: string[]) => void): Unsubscribe {
    let stop: (() => void) | null = null;
    let cancelled = false;
    listen<string[]>("files-changed", (e) => cb(e.payload)).then((un) => {
      if (cancelled) un();
      else stop = un;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  build() {
    return invoke<BuildManifest>("build");
  }

  check(level: "fast" | "full") {
    return invoke<CheckReport>("check", { level });
  }

  export(format: "step" | "stl" | "3mf", outDir?: string) {
    return invoke<ExportResult>("export", { format, outDir: outDir ?? null });
  }

  readFile(path: string) {
    return invoke<string>("read_file", { path });
  }

  loadAsset(path: string) {
    return invoke<ArrayBuffer>("load_asset", { path });
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
