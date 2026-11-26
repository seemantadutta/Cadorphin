import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useBackend } from "./backend/context";
import { AboutDialog } from "./components/AboutDialog";
import { BottomPanel, type BottomTab, type TermTab } from "./components/BottomPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { PreferencesDialog, type PrefsSection } from "./components/PreferencesDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";
import { Welcome } from "./components/Welcome";
import { projectKey, settings, type ProjectAgent, type ThemeChoice } from "./settings";
import { agentFor, findAgent, type AgentDef } from "./terminal/agents";
import { useProject } from "./state/useProject";
import type { NewProjectOptions } from "./backend/types";
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
  const [openFiles, setOpenFiles] = useState<{ path: string; text: string }[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "prefs"; section: PrefsSection }
    | { kind: "about" }
    | { kind: "new" }
    | { kind: "confirm"; title: string; body: string; label: string; action: () => void; offerDontAsk?: boolean }
    | { kind: "message"; title: string; body: string }
    | null
  >(null);
  const closeDialog = useCallback(() => setDialog(null), []);
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
    await runCheck();
    setTab("problems");
    setPanelOpen(true);
  }, [runCheck]);

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
        else if (id === "preferences") setDialog({ kind: "prefs", section: "printer" });
        else if (id === "about") setDialog({ kind: "about" });
      }),
    [backend, newProject, openFolder, close],
  );

  // Ctrl/Cmd+Shift+C runs checks. Ctrl/Cmd+, opens Preferences (the menu accelerator does too;
  // opening twice is harmless, and this also covers the browser preview, which has no menu).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void check();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setDialog((d) => d ?? { kind: "prefs", section: "printer" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [check]);

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

  const openFile = async (path: string) => {
    if (!openFiles.some((f) => f.path === path)) {
      let text: string;
      try {
        text = await backend.readFile(path);
      } catch (e) {
        text = String(e);
      }
      setOpenFiles((fs) => [...fs, { path, text }]);
    }
    setActiveFile(path);
  };

  // Keep open code tabs fresh when the project changes on disk.
  useEffect(() => {
    if (!openFiles.length) return;
    Promise.all(openFiles.map(async (f) => ({ path: f.path, text: await backend.readFile(f.path).catch((e) => String(e)) }))).then(
      setOpenFiles,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastBuiltAt, state.project]);

  const closeFile = (path: string) => {
    setOpenFiles((fs) => fs.filter((f) => f.path !== path));
    if (activeFile === path) setActiveFile(null);
  };

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
                    <div className="code-head muted small">{current.path} · read-only</div>
                    <pre className="mono">{current.text}</pre>
                  </div>
                )}
              </div>
              <BottomPanel
                open={panelOpen}
                tab={tab}
                log={state.log}
                problems={state.problems}
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
