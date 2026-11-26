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
import info from "./fixtures/enclosure/info.json";
import manifest from "./fixtures/enclosure/manifest.json";

// GLBs produced by `cadkit build` on the enclosure template (see fixtures/README.md).
const glbUrls = import.meta.glob("./fixtures/enclosure/*.glb", { query: "?url", import: "default", eager: true }) as Record<
  string,
  string
>;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fixture-backed backend for tests and for running the UI in a plain browser (`npm run dev`). */
export class MockBackend implements Backend {
  private listeners = new Set<(paths: string[]) => void>();

  async engineInfo(): Promise<EngineInfo> {
    return { cadkit: "0.1.0 (mock)", build123d: "0.13.0", python: "mock" };
  }

  async initialProject() {
    return "/mock/demo"; // the browser preview opens the fixture project straight away
  }

  async pickProjectFolder() {
    return "/mock/demo";
  }

  async openProject(): Promise<ProjectInfo> {
    await delay(50);
    return info as ProjectInfo;
  }

  async projectInfo(): Promise<ProjectInfo> {
    return info as ProjectInfo;
  }

  onFileChanged(cb: (paths: string[]) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Tests can simulate an edit. */
  emitFileChanged(paths: string[]) {
    this.listeners.forEach((cb) => cb(paths));
  }

  async build(): Promise<BuildManifest> {
    await delay(300);
    return { ...(manifest as unknown as BuildManifest), exit_code: 0, log: "" };
  }

  async check(): Promise<CheckReport> {
    await delay(300);
    const m = manifest as unknown as BuildManifest;
    return { ok: true, exit_code: 0, bodies: m.bodies, problems: [], errors: [], notes: [] };
  }

  async export(): Promise<ExportResult> {
    throw new NotYetImplemented("Export from the app", "M4");
  }

  async readFile(path: string) {
    return `# ${path}\n# (mock backend: file contents are not available in the browser preview)\n`;
  }

  async loadAsset(path: string): Promise<ArrayBuffer> {
    const name = path.split("/").pop();
    const url = glbUrls[`./fixtures/enclosure/${name}`];
    if (!url) throw new Error(`No fixture for ${path}`);
    return (await fetch(url)).arrayBuffer();
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
