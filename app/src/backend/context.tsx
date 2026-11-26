import { createContext, useContext, type ReactNode } from "react";

import type { Backend } from "./types";

const BackendContext = createContext<Backend | null>(null);

/** Components get the backend from here; they never import an implementation directly. */
export function BackendProvider({ backend, children }: { backend: Backend | null; children: ReactNode }) {
  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>;
}

export function useBackend(): Backend {
  const backend = useContext(BackendContext);
  if (!backend) throw new Error("useBackend() called outside <BackendProvider> or before a backend was chosen");
  return backend;
}
