import type { ControlsMode, Projection } from "./viewer/Viewer";

export type ThemeChoice = "system" | "light" | "dark";
export type ExportFormat = "3mf" | "stl" | "step";

/** The agent a project uses (see terminal/agents.ts), and the session to resume when it reopens. */
export interface ProjectAgent {
  /** "claude", "codex", ... or "custom:<command>". */
  agent: string;
  /** Claude Code only: the session id the app started it with. */
  sessionId?: string;
}

interface Settings {
  lastProject: string | null;
  /** Most recent first. Shown on the start screen. */
  recentProjects: string[];
  /** Where the New Project dialog creates projects. */
  projectsDir: string | null;
  /** The printer the New Project dialog suggests. */
  lastPrinter: string;
  /** Sidebar tree: which sections, parameter groups and bodies are open (missing = default). */
  sidebarFolds: Record<string, boolean>;
  /** The export dialog's last format, and its output folder per project (missing = .cad/export). */
  exportFormat: ExportFormat;
  exportDirs: Record<string, string>;
  /** The export dialog lists the bodies to choose from (off = always export all of them). */
  exportChooseBodies: boolean;
  /** Per project: bodies the user left out of the last export. Stored as left-out names so new bodies start ticked. */
  exportExcluded: Record<string, string[]>;
  /** Ask before leaving a project closes terminals the user has worked in. */
  confirmCloseTerminals: boolean;
  /** The agent id the New Project dialog suggests ("" = a plain terminal). */
  newProjectAgent: string;
  /** Per project folder (see projectKey). Per user and machine, so not stored in the project. */
  projectAgents: Record<string, ProjectAgent>;
  controls: ControlsMode;
  projection: Projection;
  theme: ThemeChoice;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  hintDismissed: boolean;
  /** Recent commands from the terminal menu's "Custom command…" box. */
  customCommands: string[];
}

const DEFAULTS: Settings = {
  lastProject: null,
  recentProjects: [],
  projectsDir: null,
  lastPrinter: "generic-256",
  newProjectAgent: "",
  confirmCloseTerminals: true,
  exportFormat: "3mf",
  exportDirs: {},
  exportChooseBodies: true,
  exportExcluded: {},
  sidebarFolds: {},
  projectAgents: {},
  controls: "orbit",
  projection: "perspective",
  theme: "system",
  bottomPanelOpen: true,
  bottomPanelHeight: 280,
  hintDismissed: false,
  customCommands: [],
};

const KEY = "cadorphin.settings";

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = load();

/** Key for per-project settings: Windows paths are case-insensitive and may use either separator. */
export function projectKey(root: string) {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Small per-user UI preferences. Storage can be unavailable; defaults are always safe. */
export const settings = {
  get<K extends keyof Settings>(key: K): Settings[K] {
    return current[key];
  },
  set<K extends keyof Settings>(key: K, value: Settings[K]) {
    current = { ...current, [key]: value };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* private mode or blocked storage: keep it in memory */
    }
  },
};
