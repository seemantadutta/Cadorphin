import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import {
  NotYetImplemented,
  type Backend,
  type BuildManifest,
  type CheckReport,
  type EngineInfo,
  type ExportResult,
  type ProjectInfo,
  type TerminalId,
  type Unsubscribe,
} from "./types";

/** Desktop backend: Tauri commands implemented in app/src-tauri/src/lib.rs. */
export class TauriBackend implements Backend {
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

  async writeParams(): Promise<void> {
    throw new NotYetImplemented("Editing parameters", "M3");
  }

  async openTerminal(): Promise<TerminalId> {
    throw new NotYetImplemented("The terminal", "M3");
  }

  writeTerminal() {}

  resizeTerminal() {}

  onTerminalData(): Unsubscribe {
    return () => {};
  }

  async closeTerminal() {}
}
