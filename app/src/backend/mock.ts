import {
  NotYetImplemented,
  type Backend,
  type BuildManifest,
  type CheckReport,
  type EngineInfo,
  type ExportResult,
  type ParamValue,
  type ProjectInfo,
  type SetParamsResult,
  type TerminalId,
  type Unsubscribe,
} from "./types";
import infoFixture from "./fixtures/enclosure/info.json";
import manifest from "./fixtures/enclosure/manifest.json";

// GLBs produced by `cadkit build` on the enclosure template (see fixtures/README.md).
const glbUrls = import.meta.glob("./fixtures/enclosure/*.glb", { query: "?url", import: "default", eager: true }) as Record<
  string,
  string
>;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pretend shell for the browser preview: echoes input and answers a few commands. */
class FakeShell {
  private line = "";
  constructor(
    private readonly emit: (data: string) => void,
    private readonly exit: (code: number) => void,
  ) {}

  start(command?: string) {
    this.emit("Cadorphin preview: this is a pretend shell (the real app runs your own shell here).\r\n");
    this.prompt();
    if (command) this.input(command + "\r");
  }

  private prompt() {
    this.emit("\x1b[36mdemo\x1b[0m> ");
  }

  input(data: string) {
    for (const ch of data) {
      if (ch === "\r") {
        this.emit("\r\n");
        this.run(this.line.trim());
        this.line = "";
      } else if (ch === "\x7f") {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          this.emit("\b \b");
        }
      } else if (ch >= " ") {
        this.line += ch;
        this.emit(ch);
      }
    }
  }

  private run(cmd: string) {
    if (cmd === "exit") return this.exit(0);
    if (cmd) this.emit(`${cmd.split(" ")[0]}: not available in the browser preview\r\n`);
    this.prompt();
  }
}

/** Fixture-backed backend for tests and for running the UI in a plain browser (`npm run dev`). */
export class MockBackend implements Backend {
  private listeners = new Set<(paths: string[]) => void>();
  private info: ProjectInfo = structuredClone(infoFixture) as ProjectInfo;
  private shells = new Map<TerminalId, FakeShell>();
  private dataSubs = new Map<TerminalId, (d: string) => void>();
  private exitSubs = new Map<TerminalId, (c: number | null) => void>();
  private pendingData = new Map<TerminalId, string[]>();
  private nextTerm = 1;

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
    return this.info;
  }

  async projectInfo(): Promise<ProjectInfo> {
    return this.info;
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

  async writeParams(values: Record<string, ParamValue>): Promise<SetParamsResult> {
    const warnings: string[] = [];
    this.info = {
      ...this.info,
      params: this.info.params.map((p) => {
        if (!(p.name in values)) return p;
        const v = values[p.name];
        if (typeof v === "number" && p.max !== undefined && v > p.max) warnings.push(`Parameter ${p.name} = ${v} is above its maximum ${p.max}`);
        if (typeof v === "number" && p.min !== undefined && v < p.min) warnings.push(`Parameter ${p.name} = ${v} is below its minimum ${p.min}`);
        return { ...p, value: v };
      }),
    };
    setTimeout(() => this.emitFileChanged(["params.toml"]), 350); // as the real file watcher would
    return { changed: values, warnings };
  }

  async openTerminal(opts: { command?: string }): Promise<TerminalId> {
    const id = `mock${this.nextTerm++}`;
    const shell = new FakeShell(
      (d) => {
        const cb = this.dataSubs.get(id);
        if (cb) cb(d);
        else this.pendingData.set(id, [...(this.pendingData.get(id) ?? []), d]);
      },
      (code) => this.exitSubs.get(id)?.(code),
    );
    this.shells.set(id, shell);
    setTimeout(() => shell.start(opts.command), 0);
    return id;
  }

  writeTerminal(id: TerminalId, data: string) {
    this.shells.get(id)?.input(data);
  }

  resizeTerminal() {}

  onTerminalData(id: TerminalId, cb: (data: string) => void): Unsubscribe {
    this.dataSubs.set(id, cb);
    this.pendingData.get(id)?.forEach(cb);
    this.pendingData.delete(id);
    return () => this.dataSubs.delete(id);
  }

  onTerminalExit(id: TerminalId, cb: (code: number | null) => void): Unsubscribe {
    this.exitSubs.set(id, cb);
    return () => this.exitSubs.delete(id);
  }

  async closeTerminal(id: TerminalId) {
    this.shells.delete(id);
  }
}
