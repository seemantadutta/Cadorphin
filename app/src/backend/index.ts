import { MockBackend } from "./mock";
import { TauriBackend } from "./tauri";
import type { Backend } from "./types";

/** Inside the desktop shell use Tauri; in a plain browser fall back to fixtures. */
export function createBackend(): Backend {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return inTauri ? new TauriBackend() : new MockBackend();
}

export type * from "./types";
