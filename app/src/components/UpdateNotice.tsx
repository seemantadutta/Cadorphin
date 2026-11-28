import { useCallback, useEffect, useRef, useState } from "react";

import type { AppUpdate } from "../backend/types";
import { useBackend } from "../backend/context";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; version: string }
  | { kind: "available"; update: AppUpdate }
  | { kind: "installing"; update: AppUpdate; progress: number | null }
  | { kind: "error"; message: string };

interface Props {
  /** Bumped by Help → Check for Updates…; a manual check also reports "up to date" and errors. */
  manualCheck: number;
  log: (kind: "info" | "error", text: string) => void;
}

const STARTUP_DELAY_MS = 4000;

/** Checks for a new release once at startup (quietly) and whenever asked, and offers to install it. */
export function UpdateNotice({ manualCheck, log }: Props) {
  const backend = useBackend();
  const [state, setState] = useState<State>({ kind: "idle" });
  const busy = useRef(false);

  const run = useCallback(
    async (manual: boolean) => {
      if (busy.current) return;
      busy.current = true;
      if (manual) setState({ kind: "checking" });
      try {
        const update = await backend.checkForUpdate();
        if (update) {
          log("info", `Cadorphin ${update.version} is available`);
          setState({ kind: "available", update });
        } else if (manual) {
          setState({ kind: "current", version: await backend.appVersion() });
        }
      } catch (e) {
        // Offline or GitHub unreachable: only worth mentioning when the user asked
        log(manual ? "error" : "info", `Update check failed: ${e}`);
        if (manual) setState({ kind: "error", message: String(e) });
      } finally {
        busy.current = false;
      }
    },
    [backend, log],
  );

  useEffect(() => {
    const t = setTimeout(() => void run(false), STARTUP_DELAY_MS);
    return () => clearTimeout(t);
  }, [run]);

  useEffect(() => {
    if (manualCheck > 0) void run(true);
  }, [manualCheck, run]);

  // "Up to date" goes away on its own
  useEffect(() => {
    if (state.kind !== "current") return;
    const t = setTimeout(() => setState({ kind: "idle" }), 5000);
    return () => clearTimeout(t);
  }, [state]);

  const install = async (update: AppUpdate) => {
    setState({ kind: "installing", update, progress: null });
    try {
      await backend.installUpdate((progress) => setState({ kind: "installing", update, progress }));
    } catch (e) {
      log("error", `Update failed: ${e}`);
      setState({ kind: "error", message: String(e) });
    }
  };

  if (state.kind === "idle") return null;
  const dismiss = () => setState({ kind: "idle" });

  return (
    <div className={`toast update ${state.kind === "error" ? "warn" : "ok"}`} role="status">
      <div className="toast-body">
        {state.kind === "checking" && <strong>Checking for updates…</strong>}
        {state.kind === "current" && <strong>Cadorphin {state.version} is the latest version</strong>}
        {state.kind === "available" && (
          <>
            <strong>Cadorphin {state.update.version} is available</strong>
            <span className="muted small">Installing restarts Cadorphin and closes its terminals.</span>
          </>
        )}
        {state.kind === "installing" && (
          <>
            <strong>Installing Cadorphin {state.update.version}…</strong>
            <span className="muted small">
              {state.progress === null ? "Downloading" : `Downloading ${Math.round(state.progress * 100)}%`}
            </span>
          </>
        )}
        {state.kind === "error" && (
          <>
            <strong>Couldn't update Cadorphin</strong>
            <span className="muted small update-error" title={state.message}>
              {state.message}
            </span>
          </>
        )}
      </div>
      <div className="toast-actions">
        {state.kind === "available" && (
          <>
            <button className="btn primary small-btn" onClick={() => void install(state.update)}>
              Install and restart
            </button>
            <button className="btn small-btn" onClick={dismiss}>
              Later
            </button>
          </>
        )}
        {state.kind !== "installing" && state.kind !== "available" && (
          <button className="close" aria-label="Dismiss" onClick={dismiss}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}
