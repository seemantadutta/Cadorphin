import { useCallback, useEffect, useRef, useState } from "react";

import { useBackend } from "../backend/context";
import type { BuildManifest, CheckReport, EngineInfo, NewProjectOptions, ParamValue, Problem, ProjectInfo } from "../backend/types";
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
  /** True from launch until the last project has been reopened (or there is none to reopen). */
  starting: boolean;
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
const MAX_RECENT = 8;

function samePath(a: string, b: string) {
  // Windows paths are case-insensitive and may use either separator.
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function useProject() {
  const backend = useBackend();
  const [state, setState] = useState<ProjectState>({
    engine: null,
    engineError: null,
    project: null,
    openError: null,
    opening: false,
    starting: true,
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
  /** Bumped on every open/close, so results that belong to a previous project are dropped. */
  const generation = useRef(0);
  const [recent, setRecent] = useState<string[]>(settings.get("recentProjects"));

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
      .catch((e) => patch({ engineError: String(e), starting: false }));
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
        const gen = generation.current;
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
        if (gen !== generation.current) {
          // The project was switched or closed mid-build: drop this result, build the new one.
          pending.current = projectRef.current !== null;
          continue;
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

  const remember = useCallback((path: string | null, root?: string) => {
    setRecent((r) => {
      const next = root ? [root, ...r.filter((p) => !samePath(p, root))].slice(0, MAX_RECENT) : r.filter((p) => !path || !samePath(p, path));
      settings.set("recentProjects", next);
      return next;
    });
  }, []);

  /** Remove a folder from the recent list (it was moved or deleted). */
  const forgetRecent = useCallback((path: string) => remember(path), [remember]);

  const resetFor = (project: ProjectInfo | null): Partial<ProjectState> => ({
    project,
    viewerBodies: [],
    manifest: null,
    problems: [],
    lastCheck: null,
    lastBuiltAt: null,
    status: "idle",
  });

  /** Open a project folder. Resolves to false (with `openError` set) if it isn't a cadkit project. */
  const openProject = useCallback(
    async (path: string): Promise<boolean> => {
      patch({ opening: true, openError: null });
      try {
        const project = await backend.openProject(path);
        generation.current += 1;
        projectRef.current = project;
        settings.set("lastProject", project.root);
        remember(null, project.root);
        patch({ ...resetFor(project), opening: false });
        log("info", `Opened ${project.root}`);
        void rebuild();
        return true;
      } catch (e) {
        patch({ opening: false, openError: String(e) });
        return false;
      }
    },
    [backend, log, patch, rebuild, remember],
  );

  const closeProject = useCallback(async () => {
    if (!projectRef.current) return;
    const root = projectRef.current.root;
    generation.current += 1;
    projectRef.current = null;
    settings.set("lastProject", null); // next launch starts on the start screen
    patch({ ...resetFor(null), openError: null });
    try {
      await backend.closeProject();
    } catch (e) {
      log("error", `Closing ${root}: ${String(e)}`);
    }
    log("info", `Closed ${root}`);
  }, [backend, log, patch]);

  /** Create a project from a template and open it. Errors go to the caller (the dialog shows them). */
  const createProject = useCallback(
    async (opts: NewProjectOptions) => {
      const path = await backend.createProject(opts);
      log("info", `Created ${path} from the ${opts.template} template`);
      if (!(await openProject(path))) throw new Error(`Created ${path}, but could not open it`);
    },
    [backend, log, openProject],
  );

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

  /** Write one parameter to params.toml. The file watcher then rebuilds, as for any other edit. */
  const setParam = useCallback(
    async (name: string, value: ParamValue) => {
      if (!projectRef.current) return;
      const before = projectRef.current;
      const optimistic = { ...before, params: before.params.map((p) => (p.name === name ? { ...p, value } : p)) };
      projectRef.current = optimistic;
      patch({ project: optimistic });
      try {
        const res = await backend.writeParams({ [name]: value });
        log("info", `Set ${Object.entries(res.changed).map(([k, v]) => `${k} = ${v}`).join(", ")}`);
        res.warnings.forEach((w) => log("error", w));
      } catch (e) {
        log("error", `Could not set ${name}: ${String(e)}`);
        projectRef.current = before;
        patch({ project: before });
      }
    },
    [backend, log, patch],
  );

  /** Choose the project's printer (project.toml). The watcher then refreshes info and rebuilds. */
  const setPrinter = useCallback(
    async (id: string) => {
      if (!projectRef.current) return;
      const profile = await backend.setProfile(id); // errors go to the caller, which shows them in place
      const [x, y, z] = profile.build_volume_mm;
      log("info", `Printer: ${profile.name} (${x} × ${y} × ${z} mm)`);
      projectRef.current = { ...projectRef.current, profile };
      patch({ project: projectRef.current });
    },
    [backend, log, patch],
  );

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
      .then(async (startup) => {
        const initial = startup?.path ?? null;
        const path = initial ?? (startup?.restore === false ? null : settings.get("lastProject"));
        if (path && !(await openProject(path)) && !initial) {
          settings.set("lastProject", null); // a moved or deleted folder: start on the start screen
          patch({ openError: null });
        }
      })
      .finally(() => patch({ starting: false }));
  }, [backend, state.engine, openProject, patch]);

  return { state, recent, openProject, closeProject, createProject, forgetRecent, rebuild, runCheck, setParam, setPrinter, log };
}
