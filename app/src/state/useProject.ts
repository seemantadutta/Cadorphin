import { useCallback, useEffect, useRef, useState } from "react";

import { useBackend } from "../backend/context";
import type { BuildManifest, CheckReport, EngineInfo, Problem, ProjectInfo } from "../backend/types";
import type { ViewerBody } from "../viewer/Viewer";
import { settings } from "../settings";

export type BuildStatus = "idle" | "building" | "built" | "error";

export interface LogEntry {
  time: Date;
  kind: "info" | "error" | "output";
  text: string;
}

export interface ProjectState {
  engine: EngineInfo | null;
  engineError: string | null;
  project: ProjectInfo | null;
  openError: string | null;
  opening: boolean;
  status: BuildStatus;
  manifest: BuildManifest | null;
  /** Bodies currently shown. A failed build keeps showing the last good model. */
  viewerBodies: ViewerBody[];
  lastBuiltAt: Date | null;
  log: LogEntry[];
  problems: Problem[];
  checking: boolean;
  lastCheck: CheckReport | null;
}

const DEFAULT_COLOR = "#B8BCC4";
const MAX_LOG = 400;

export function useProject() {
  const backend = useBackend();
  const [state, setState] = useState<ProjectState>({
    engine: null,
    engineError: null,
    project: null,
    openError: null,
    opening: false,
    status: "idle",
    manifest: null,
    viewerBodies: [],
    lastBuiltAt: null,
    log: [],
    problems: [],
    checking: false,
    lastCheck: null,
  });
  const building = useRef(false);
  const pending = useRef(false);
  const projectRef = useRef<ProjectInfo | null>(null);

  const patch = useCallback((p: Partial<ProjectState> | ((s: ProjectState) => Partial<ProjectState>)) => {
    setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
  }, []);

  const log = useCallback(
    (kind: LogEntry["kind"], text: string) => {
      if (!text.trim()) return;
      patch((s) => ({ log: [...s.log, { time: new Date(), kind, text }].slice(-MAX_LOG) }));
    },
    [patch],
  );

  // Start the CAD engine early so the first build doesn't pay Python's startup cost.
  useEffect(() => {
    backend
      .engineInfo()
      .then((engine) => patch({ engine }))
      .catch((e) => patch({ engineError: String(e) }));
  }, [backend, patch]);

  const rebuild = useCallback(async () => {
    if (!projectRef.current) return;
    if (building.current) {
      pending.current = true; // coalesce edits that arrive mid-build into one more build
      return;
    }
    building.current = true;
    patch({ status: "building" });
    try {
      do {
        pending.current = false;
        const t0 = performance.now();
        const manifest = await backend.build();
        if (manifest.log) log("output", manifest.log);
        const shown = manifest.bodies.filter((b) => b.glb);
        let viewerBodies: ViewerBody[] | null = null;
        if (shown.length && manifest.exit_code !== 2 && manifest.exit_code !== 3) {
          viewerBodies = await Promise.all(
            shown.map(async (b) => ({ name: b.name, color: b.color ?? DEFAULT_COLOR, glb: await backend.loadAsset(b.glb!) })),
          );
        }
        const ms = Math.round(performance.now() - t0);
        const failed = manifest.exit_code === 2 || manifest.exit_code === 3;
        if (failed) manifest.errors.forEach((e) => log("error", e));
        else log("info", `Built ${manifest.bodies.length} bodies in ${(ms / 1000).toFixed(1)} s`);
        patch((s) => ({
          manifest,
          status: failed ? "error" : "built",
          viewerBodies: viewerBodies ?? s.viewerBodies,
          lastBuiltAt: failed ? s.lastBuiltAt : new Date(),
          problems: manifest.problems,
        }));
      } while (pending.current);
    } catch (e) {
      log("error", String(e));
      patch({ status: "error" });
    } finally {
      building.current = false;
    }
  }, [backend, log, patch]);

  const openProject = useCallback(
    async (path: string) => {
      patch({ opening: true, openError: null });
      try {
        const project = await backend.openProject(path);
        projectRef.current = project;
        settings.set("lastProject", path);
        patch({ project, opening: false, viewerBodies: [], manifest: null, problems: [], lastCheck: null, status: "idle" });
        log("info", `Opened ${project.root}`);
        await rebuild();
      } catch (e) {
        patch({ opening: false, openError: String(e) });
      }
    },
    [backend, log, patch, rebuild],
  );

  const pickAndOpen = useCallback(async () => {
    const path = await backend.pickProjectFolder();
    if (path) await openProject(path);
  }, [backend, openProject]);

  const runCheck = useCallback(async () => {
    if (!projectRef.current) return;
    patch({ checking: true });
    try {
      const report = await backend.check("fast");
      if (report.log) log("output", report.log);
      report.errors.forEach((e) => log("error", e));
      const n = report.problems.length;
      log("info", n ? `Check found ${n} problem${n === 1 ? "" : "s"}` : "Check passed: no problems found");
      patch({ lastCheck: report, problems: report.problems, checking: false });
    } catch (e) {
      log("error", String(e));
      patch({ checking: false });
    }
  }, [backend, log, patch]);

  // Rebuild when model files change on disk (the agent or an editor saved something).
  useEffect(() => {
    return backend.onFileChanged(async (paths) => {
      if (!projectRef.current) return;
      log("info", `Changed: ${paths.join(", ")}`);
      try {
        const project = await backend.projectInfo();
        projectRef.current = project;
        patch({ project });
      } catch {
        /* the build below reports the problem */
      }
      await rebuild();
    });
  }, [backend, log, patch, rebuild]);

  // On startup, once the engine is up: open the project given at launch, else the last one.
  const reopened = useRef(false);
  useEffect(() => {
    if (reopened.current || !state.engine) return;
    reopened.current = true;
    backend
      .initialProject()
      .catch(() => null)
      .then((initial) => {
        const path = initial ?? settings.get("lastProject");
        if (path) void openProject(path);
      });
  }, [backend, state.engine, openProject]);

  return { state, openProject, pickAndOpen, rebuild, runCheck };
}
