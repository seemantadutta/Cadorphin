import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useBackend } from "./backend/context";
import { AboutDialog } from "./components/AboutDialog";
import { BottomPanel, type BottomTab, type TermTab } from "./components/BottomPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ExportDialog, type ExportOutcome } from "./components/ExportDialog";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { PreferencesDialog, type PrefsSection } from "./components/PreferencesDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";
import { UpdateNotice } from "./components/UpdateNotice";
import { Welcome } from "./components/Welcome";
import { projectKey, settings, type ProjectAgent, type ThemeChoice } from "./settings";
import { agentFor, findAgent, type AgentDef } from "./terminal/agents";
import { useProject } from "./state/useProject";
import type { NewProjectOptions } from "./backend/types";
import { selectionFile, summarize, type Pick, type Topo } from "./viewer/topo";
import type { ControlsMode } from "./viewer/Viewer";
import { ViewerPane } from "./viewer/ViewerPane";

function useTheme(choice: ThemeChoice): "light" | "dark" {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = useState(query.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, [query]);
  const theme = choice === "system" ? (systemDark ? "dark" : "light") : choice;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return theme;
}

export function App() {
  const backend = useBackend();
  const { state, recent, openProject, closeProject, createProject, forgetRecent, runCheck, setParam, setPrinter, log } = useProject();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(settings.get("bottomPanelOpen"));
  const [tab, setTab] = useState<BottomTab>("log");
  const [terminals, setTerminals] = useState<TermTab[]>([]);
  const termSeq = useRef(0); // unique tab keys for the app's lifetime
  const termNumber = useRef(0); // "Terminal 2", per project
  /** Set by New Project: the agent id the new project's first terminal should start. */
  const startAgent = useRef<string | null>(null);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(settings.get("theme"));
  const [controls, setControls] = useState<ControlsMode>(settings.get("controls"));
  /** Read-only document tabs: text files, or images (renders) as blob URLs. */
  const [openFiles, setOpenFiles] = useState<{ path: string; text?: string; image?: string }[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "prefs"; section: PrefsSection }
    | { kind: "about" }
    | { kind: "new" }
    | { kind: "confirm"; title: string; body: string; label: string; action: () => void; offerDontAsk?: boolean }
    | { kind: "message"; title: string; body: string }
    | { kind: "export"; only?: string }
    | null
  >(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const [updateCheck, setUpdateCheck] = useState(0); // bumped by Help → Check for Updates…
  // Point-and-fix: what is picked in the viewer, and whether its reference still has to be pasted
  // into a terminal (it is pasted once, the next time a terminal gets focus).
  const [selection, setSelection] = useState<{ picks: Pick[]; summary: string; pasted: boolean } | null>(null);
  const pendingPaste = useRef<string | null>(null);
  const pasteFns = useRef(new Map<string, (text: string) => void>());
  const [clearSelection, setClearSelection] = useState(0);
  // Problems: the one shown in the view, and the viewer's glide target.
  const [activeProblem, setActiveProblem] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ location: [number, number, number]; n: number } | null>(null);
  const lastTerminal = useRef<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "warn"; title: string; files: string[]; folder: string; warnings: number } | null>(
    null,
  );
  const theme = useTheme(themeChoice);

  const bodies = useMemo(() => state.manifest?.bodies ?? [], [state.manifest]);
  const errorCount = state.problems.filter((p) => p.severity === "error").length;

  const bboxText = useMemo(() => {
    const shown = bodies.filter((b) => !hidden.has(b.name));
    if (!shown.length) return null;
    const min = [0, 1, 2].map((i) => Math.min(...shown.map((b) => b.bbox_min[i])));
    const max = [0, 1, 2].map((i) => Math.max(...shown.map((b) => b.bbox_min[i] + b.bbox[i])));
    return max.map((v, i) => (v - min[i]).toFixed(1)).join(" × ") + " mm";
  }, [bodies, hidden]);

  const toggleBody = (name: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const togglePanel = () =>
    setPanelOpen((o) => {
      settings.set("bottomPanelOpen", !o);
      return !o;
    });

  const check = useCallback(async () => {
    if (!state.project) return;
    setTab("problems"); // shows "Checking…" while it runs
    setPanelOpen(true);
    await runCheck("full");
  }, [runCheck, state.project]);

  /** `only`: start with just that body ticked (the sidebar's "Export this body…"). */
  const openExport = useCallback(
    (only?: string) => {
      if (state.project && state.manifest?.bodies.length) setDialog({ kind: "export", only });
    },
    [state.project, state.manifest],
  );

  // Leaving a project (open another, new, close) closes its terminals. Ask first if any of them
  // is in use, since an agent may be working in it.
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const leaveProject = useCallback((verb: string, action: () => void) => {
    const busy = terminalsRef.current.filter((t) => t.used && !t.exited);
    if (!busy.length || !settings.get("confirmCloseTerminals")) return action();
    const n = busy.length;
    setDialog({
      kind: "confirm",
      title: `${verb}?`,
      body: `This closes ${n === 1 ? "the terminal" : `${n} terminals`} you used in this project. Anything still running there, such as an agent, will be stopped.`,
      label: `Close terminal${n === 1 ? "" : "s"} and continue`,
      action,
      offerDontAsk: true,
    });
  }, []);

  const openFolder = useCallback(
    async (path?: string) => {
      const target = path ?? (await backend.pickFolder("Open a Cadorphin project folder", state.project?.root));
      if (!target) return;
      const go = async () => {
        setDialog(null);
        const ok = await openProject(target);
        // With no project open the start screen shows the error; otherwise say so here.
        if (!ok && state.project) setDialog({ kind: "message", title: "Could not open the project", body: "" });
      };
      if (state.project) leaveProject("Open another project", () => void go());
      else void go();
    },
    [backend, openProject, leaveProject, state.project],
  );

  const newProject = useCallback(() => {
    if (state.project) leaveProject("Start a new project", () => setDialog({ kind: "new" }));
    else setDialog({ kind: "new" });
  }, [leaveProject, state.project]);

  const close = useCallback(() => {
    if (!state.project) return;
    leaveProject("Close the project", () => {
      setDialog(null);
      void closeProject();
    });
  }, [closeProject, leaveProject, state.project]);

  // Native menu (File / Edit / Help).
  useEffect(
    () =>
      backend.onMenu((id) => {
        if (id === "new") newProject();
        else if (id === "open") void openFolder();
        else if (id === "close") close();
        else if (id === "export") openExport();
        else if (id === "preferences") setDialog({ kind: "prefs", section: "printer" });
        else if (id === "about") setDialog({ kind: "about" });
        else if (id === "check_updates") setUpdateCheck((n) => n + 1);
      }),
    [backend, newProject, openFolder, close, openExport],
  );

  // Ctrl/Cmd+Shift+C runs checks. Ctrl/Cmd+, opens Preferences (the menu accelerator does too;
  // opening twice is harmless, and this also covers the browser preview, which has no menu).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void check();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        openExport();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setDialog((d) => d ?? { kind: "prefs", section: "printer" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [check, openExport]);

  // Show build failures in the log, but never pull the user out of a terminal (an agent may be
  // mid-edit); the status pill shows the failure there.
  useEffect(() => {
    if (state.status === "error") {
      setTab((t) => (t.startsWith("term:") ? t : "log"));
    }
  }, [state.status]);

  const newTerminal = useCallback((command?: string, label?: string) => {
    termSeq.current += 1;
    termNumber.current += 1;
    const n = termNumber.current;
    const key = String(termSeq.current);
    setTerminals((ts) => [
      ...ts,
      { key, label: label ?? (n === 1 ? "Terminal" : `Terminal ${n}`), command, exited: false, used: !!command },
    ]);
    setTab(`term:${key}`);
    setPanelOpen(true);
  }, []);

  const closeTerminal = (key: string) => {
    setTerminals((ts) => {
      const rest = ts.filter((t) => t.key !== key);
      setTab((cur) => (cur === `term:${key}` ? (rest.length ? `term:${rest[rest.length - 1].key}` : "log") : cur));
      return rest;
    });
  };

  /** Start a new conversation with `agent` in a new terminal, and make it the project's agent. */
  const startAgentIn = useCallback(
    (root: string, agent: AgentDef) => {
      const { command, sessionId } = agent.start();
      const rec: ProjectAgent = { agent: agent.id, ...(sessionId ? { sessionId } : {}) };
      settings.set("projectAgents", { ...settings.get("projectAgents"), [projectKey(root)]: rec });
      newTerminal(command, agent.label);
    },
    [newTerminal],
  );

  // A different project (or none): drop the old project's terminals, code tabs and hidden bodies
  // (unmounting a terminal kills its shell). Then open the new project's first terminal: the agent
  // chosen in New Project, else the project's agent resuming its last session, else a plain shell.
  const projectRoot = state.project?.root;
  const currentRoot = useRef(projectRoot);
  currentRoot.current = projectRoot;
  useEffect(() => {
    setTerminals([]);
    termNumber.current = 0;
    setOpenFiles([]);
    setActiveFile(null);
    setHidden(new Set());
    setTab("log");
    if (!projectRoot) return;
    const chosen = startAgent.current ? agentFor(startAgent.current) : undefined;
    startAgent.current = null;
    if (chosen) return startAgentIn(projectRoot, chosen);
    const key = projectKey(projectRoot);
    const rec = settings.get("projectAgents")[key];
    const agent = rec && agentFor(rec.agent);
    if (agent && agent.id !== "claude") return newTerminal(agent.resume(), agent.label);
    // Claude Code, or no agent recorded (e.g. a project made before Cadorphin remembered agents):
    // continue the newest conversation Claude has saved for this folder, whoever started it.
    const claude = findAgent("claude")!;
    void backend
      .claudeSessions(projectRoot)
      .catch(() => [] as string[])
      .then((ids) => {
        if (currentRoot.current !== projectRoot) return; // switched project meanwhile
        const id = ids[0];
        if (id) {
          settings.set("projectAgents", { ...settings.get("projectAgents"), [key]: { agent: claude.id, sessionId: id } });
          newTerminal(claude.resume(id), claude.label);
        } else if (agent) {
          startAgentIn(projectRoot, claude); // Claude is the project's agent but saved nothing yet
        } else {
          newTerminal();
        }
      });
  }, [projectRoot, newTerminal, startAgentIn, backend]);

  const createAndOpen = useCallback(
    async (opts: NewProjectOptions, agent: string | null) => {
      // The effect above takes it when the new project's root arrives (it may render after this
      // promise resolves, so only clear it here if creating or opening failed).
      startAgent.current = agent;
      try {
        await createProject(opts);
      } catch (e) {
        startAgent.current = null;
        throw e;
      }
    },
    [createProject],
  );

  const viewerBodiesRef = useRef(state.viewerBodies);
  viewerBodiesRef.current = state.viewerBodies;
  const onSelection = useCallback(
    (picks: Pick[], capture: () => string) => {
      if (!picks.length) {
        setSelection(null);
        pendingPaste.current = null;
        void backend.writeSelection(null).catch(() => {});
        return;
      }
      const topos = new Map<string, Topo>();
      for (const b of viewerBodiesRef.current) if (b.topo) topos.set(b.name, b.topo);
      const summary = summarize(picks, topos);
      setSelection({ picks, summary, pasted: false });
      pendingPaste.current = summary;
      const file = { ...selectionFile(picks, topos), screenshot: ".cad/selection.png" };
      void backend
        .writeSelection(JSON.stringify(file, null, 2), dataUrlBytes(capture()))
        .catch((e) => log("error", `Could not save the selection: ${String(e)}`));
    },
    [backend, log],
  );

  const onTerminalFocus = useCallback((key: string) => {
    lastTerminal.current = key;
    const text = pendingPaste.current;
    const paste = pasteFns.current.get(key);
    if (!text || !paste) return;
    pendingPaste.current = null;
    paste(text + " ");
    setSelection((s) => (s ? { ...s, pasted: true } : s));
  }, []);

  const readDoc = useCallback(
    async (path: string): Promise<{ path: string; text?: string; image?: string }> => {
      try {
        if (path.toLowerCase().endsWith(".png")) {
          const bytes = await backend.loadAsset(path);
          return { path, image: URL.createObjectURL(new Blob([bytes], { type: "image/png" })) };
        }
        return { path, text: await backend.readFile(path) };
      } catch (e) {
        return { path, text: String(e) };
      }
    },
    [backend],
  );

  const openFile = async (path: string) => {
    if (!openFiles.some((f) => f.path === path)) {
      const doc = await readDoc(path);
      setOpenFiles((fs) => [...fs, doc]);
    }
    setActiveFile(path);
  };

  // Keep open tabs fresh when the project changes on disk or a new check redraws the renders.
  useEffect(() => {
    if (!openFiles.length) return;
    const old = openFiles;
    void Promise.all(old.map((f) => readDoc(f.path))).then((fresh) => {
      old.forEach((f) => f.image && URL.revokeObjectURL(f.image));
      setOpenFiles(fresh);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastBuiltAt, state.project, state.lastCheck]);

  const closeFile = (path: string) => {
    setOpenFiles((fs) => {
      fs.filter((f) => f.path === path && f.image).forEach((f) => URL.revokeObjectURL(f.image!));
      return fs.filter((f) => f.path !== path);
    });
    if (activeFile === path) setActiveFile(null);
  };

  // ---- problems: markers in the view, show one, send one to the agent
  useEffect(() => setActiveProblem(null), [state.problems]);
  const markers = useMemo(
    () =>
      state.problems.flatMap((p, i) =>
        p.location && !hidden.has(p.body ?? "") ? [{ location: p.location, severity: p.severity, active: i === activeProblem }] : [],
      ),
    [state.problems, activeProblem, hidden],
  );

  const showProblem = (i: number) => {
    const p = state.problems[i];
    setActiveProblem(i);
    if (p?.location) {
      setActiveFile(null); // back to the model
      setFocus((f) => ({ location: p.location!, n: (f?.n ?? 0) + 1 }));
    }
  };

  const sendProblem = (i: number) => {
    const p = state.problems[i];
    if (!p) return;
    const fromTab = tab.startsWith("term:") ? tab.slice(5) : null;
    const last = lastTerminal.current && terminals.some((t) => t.key === lastTerminal.current) ? lastTerminal.current : null;
    const key = fromTab ?? last ?? terminals[0]?.key;
    const paste = key ? pasteFns.current.get(key) : undefined;
    if (!key || !paste) {
      log("error", "Open a terminal with your agent first, then send the problem again.");
      return;
    }
    const where = p.location && !/\((-?\d|\s)/.test(p.message) ? ` near (${p.location.map((v) => v.toFixed(1)).join(", ")})` : "";
    paste(`[Cadorphin check, ${p.severity}] ${p.message}${where} `);
    setTab(`term:${key}`);
    setPanelOpen(true);
  };

  const onExported = ({ result, warnings, folder }: ExportOutcome) => {
    const files = result.files;
    log("info", `Exported ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}`);
    setToast({
      kind: warnings.length ? "warn" : "ok",
      title: `Exported ${files.length} file${files.length === 1 ? "" : "s"}${warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}`,
      files,
      folder,
      warnings: warnings.length,
    });
  };

  // A clean export's notice goes away on its own; one with warnings stays until dismissed.
  useEffect(() => {
    if (toast?.kind !== "ok") return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const current = openFiles.find((f) => f.path === activeFile);

  return (
    <div className="app">
      <TopBar
        projectName={state.project?.name ?? null}
        status={state.status}
        lastBuiltAt={state.lastBuiltAt}
        bodyCount={bodies.length}
        errorCount={errorCount}
        checking={state.checking}
        onCheck={check}
        onExport={() => openExport()}
        onOpen={() => void openFolder()}
      />
      <div className="main">
        {state.project && (
          <Sidebar
            project={state.project}
            bodies={bodies}
            hidden={hidden}
            activeFile={activeFile}
            onOpenFile={openFile}
            onToggleBody={toggleBody}
            onSetParam={setParam}
            onExportBody={openExport}
          />
        )}
        <main className="center">
          {state.project ? (
            <>
              {openFiles.length > 0 && (
                <div className="doc-tabs" role="tablist">
                  <button role="tab" className={activeFile === null ? "doc-tab active" : "doc-tab"} onClick={() => setActiveFile(null)}>
                    Model
                  </button>
                  {openFiles.map((f) => (
                    <span key={f.path} className={activeFile === f.path ? "doc-tab active" : "doc-tab"}>
                      <button role="tab" className="mono" onClick={() => setActiveFile(f.path)}>
                        {f.path}
                      </button>
                      <button className="close" aria-label={`Close ${f.path}`} onClick={() => closeFile(f.path)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="stack">
                <div className={current ? "layer hidden" : "layer"}>
                  <ViewerPane
                    bodies={state.viewerBodies}
                    hidden={hidden}
                    bboxText={bboxText}
                    theme={theme}
                    controlsMode={controls}
                    onSelection={onSelection}
                    clearSignal={clearSelection}
                    markers={markers}
                    focus={focus}
                    overlay={
                      <button
                        className="gear"
                        onClick={() => setDialog({ kind: "prefs", section: "viewer" })}
                        aria-label="Preferences"
                        title="Preferences (Ctrl+,)"
                      >
                        ⚙
                      </button>
                    }
                  />
                  {selection && (
                    <div className="selection-chip" role="status">
                      <span className="selection-what">{selection.summary.replace(/^\[Selected in the Cadorphin viewer: /, "").replace(/\. Details:.*$/, "")}</span>
                      <span className="muted small">
                        {selection.pasted ? "Added to your prompt" : "Click in the terminal to refer to it"} · Esc clears
                      </span>
                      <button className="close" aria-label="Clear selection" onClick={() => setClearSelection((n) => n + 1)}>
                        ×
                      </button>
                    </div>
                  )}
                  {state.status === "built" && bodies.length === 0 && (
                    <div className="viewer-empty">
                      <p>Nothing here yet.</p>
                      <p className="muted small">
                        Describe the part to your agent in the terminal below, or edit <code>model.py</code>. The view updates as soon as
                        <code> build()</code> returns a body.
                      </p>
                    </div>
                  )}
                </div>
                {current && (
                  <div className="layer code-view">
                    <div className="code-head muted small">
                      {current.path} · {current.image ? "from the last full check" : "read-only"}
                    </div>
                    {current.image ? (
                      <div className="image-view">
                        <img src={current.image} alt={current.path} />
                      </div>
                    ) : (
                      <pre className="mono">{current.text}</pre>
                    )}
                  </div>
                )}
              </div>
              <BottomPanel
                open={panelOpen}
                tab={tab}
                log={state.log}
                problems={state.problems}
                renders={state.lastCheck?.renders ?? []}
                checking={state.checking}
                activeProblem={activeProblem}
                onShowProblem={showProblem}
                onSendProblem={sendProblem}
                onOpenRender={(p) => void openFile(p)}
                onCheck={() => void check()}
                terminals={terminals}
                theme={theme}
                onTab={setTab}
                onToggle={togglePanel}
                onNewTerminal={newTerminal}
                onStartAgent={(id) => {
                  const agent = findAgent(id);
                  if (agent && projectRoot) startAgentIn(projectRoot, agent);
                }}
                onCloseTerminal={closeTerminal}
                onTerminalExit={(key) => setTerminals((ts) => ts.map((t) => (t.key === key ? { ...t, exited: true } : t)))}
                onTerminalFocus={onTerminalFocus}
                registerTerminalPaste={(key, paste) => {
                  if (paste) pasteFns.current.set(key, paste);
                  else pasteFns.current.delete(key);
                }}
                onTerminalInput={(key) => setTerminals((ts) => ts.map((t) => (t.key === key && !t.used ? { ...t, used: true } : t)))}
                onTerminalError={(m) => log("error", `Terminal: ${m}`)}
              />
            </>
          ) : state.starting ? (
            // Until the engine is up and the last project has been reopened, show a quiet splash
            // instead of flashing the start screen.
            <div className="welcome splash" aria-busy="true">
              <span className="muted small">Starting…</span>
            </div>
          ) : (
            <Welcome
              engineReady={!!state.engine}
              engineError={state.engineError}
              opening={state.opening}
              openError={state.openError}
              recent={recent}
              onNew={newProject}
              onOpen={() => void openFolder()}
              onOpenRecent={(p) => void openFolder(p)}
              onForgetRecent={forgetRecent}
            />
          )}
        </main>
      </div>
      <StatusBar
        project={state.project}
        engine={state.engine}
        engineError={state.engineError}
        onPrinter={() => setDialog({ kind: "prefs", section: "printer" })}
      />
      {dialog?.kind === "prefs" && (
        <PreferencesDialog
          initialSection={dialog.section}
          project={state.project}
          theme={themeChoice}
          controls={controls}
          onTheme={(t) => {
            setThemeChoice(t);
            settings.set("theme", t);
          }}
          onControls={(m) => {
            setControls(m);
            settings.set("controls", m);
          }}
          onPrinter={setPrinter}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "about" && <AboutDialog engine={state.engine} onClose={closeDialog} />}
      {dialog?.kind === "export" && state.project && (
        <ExportDialog
          projectRoot={state.project.root}
          bodies={bodies}
          hidden={hidden}
          only={dialog.only}
          runCheck={() => runCheck("full")}
          onExported={onExported}
          onFix={() => {
            setDialog(null);
            setTab("problems");
            setPanelOpen(true);
          }}
          onClose={closeDialog}
        />
      )}
      <UpdateNotice manualCheck={updateCheck} log={log} />
      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <div className="toast-body">
            <strong>{toast.title}</strong>
            <span className="muted small mono">{toast.files.map((f) => f.split(/[\\/]/).pop()).join(", ")}</span>
          </div>
          <div className="toast-actions">
            <button className="btn small-btn" onClick={() => void backend.revealFolder(toast.folder).catch((e) => log("error", String(e)))}>
              Open folder
            </button>
            {toast.warnings > 0 && (
              <button
                className="btn small-btn"
                onClick={() => {
                  setTab("problems");
                  setPanelOpen(true);
                  setToast(null);
                }}
              >
                Show problems
              </button>
            )}
            <button className="close" aria-label="Dismiss" onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        </div>
      )}
      {dialog?.kind === "new" && <NewProjectDialog onCreate={createAndOpen} onClose={closeDialog} />}
      {dialog?.kind === "confirm" && (
        <ConfirmDialog
          title={dialog.title}
          confirmLabel={dialog.label}
          danger
          offerDontAsk={dialog.offerDontAsk}
          onConfirm={(dontAsk) => {
            if (dontAsk) settings.set("confirmCloseTerminals", false);
            dialog.action();
          }}
          onClose={closeDialog}
        >
          <p>{dialog.body}</p>
          {dialog.offerDontAsk && <p className="muted small">You can turn this back on in Preferences → Terminals.</p>}
        </ConfirmDialog>
      )}
      {dialog?.kind === "message" && (
        <ConfirmDialog title={dialog.title} onClose={closeDialog}>
          <p className="error-text">{dialog.body || state.openError}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** The bytes of a "data:image/png;base64,..." URL. */
function dataUrlBytes(url: string): Uint8Array | undefined {
  const b64 = url.split(",")[1];
  if (!b64) return undefined;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
