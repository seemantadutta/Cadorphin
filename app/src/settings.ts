import type { ControlsMode, Projection } from "./viewer/Viewer";

export type ThemeChoice = "system" | "light" | "dark";

interface Settings {
  lastProject: string | null;
  controls: ControlsMode;
  projection: Projection;
  theme: ThemeChoice;
  bottomPanelOpen: boolean;
  hintDismissed: boolean;
}

const DEFAULTS: Settings = {
  lastProject: null,
  controls: "orbit",
  projection: "perspective",
  theme: "system",
  bottomPanelOpen: true,
  hintDismissed: false,
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
