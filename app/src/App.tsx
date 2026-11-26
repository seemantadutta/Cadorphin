import { useCallback, useEffect, useMemo, useState } from "react";

import { useBackend } from "./backend/context";
import { BottomPanel, type BottomTab } from "./components/BottomPanel";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";
import { Welcome } from "./components/Welcome";
import { settings, type ThemeChoice } from "./settings";
import { useProject } from "./state/useProject";
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
  const { state, pickAndOpen, runCheck } = useProject();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(settings.get("bottomPanelOpen"));
  const [tab, setTab] = useState<BottomTab>("log");
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(settings.get("theme"));
  const [controls, setControls] = useState<ControlsMode>(settings.get("controls"));
  const [openFiles, setOpenFiles] = useState<{ path: string; text: string }[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
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

  // Ctrl/Cmd+Shift+C runs checks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void check();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [check]);

  // Show build failures in the log.
  useEffect(() => {
    if (state.status === "error") {
      setTab("log");
      setPanelOpen(true);
    }
  }, [state.status]);

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
        onOpen={pickAndOpen}
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
                      <button className="gear" onClick={() => setShowSettings((s) => !s)} aria-label="Viewer settings" title="Settings">
                        ⚙
                      </button>
                    }
                  />
                  {showSettings && (
                    <div className="settings-pop" role="dialog" aria-label="Settings">
                      <h3>Mouse controls</h3>
                      {(["orbit", "trackball"] as ControlsMode[]).map((m) => (
                        <label key={m}>
                          <input
                            type="radio"
                            name="controls"
                            checked={controls === m}
                            onChange={() => {
                              setControls(m);
                              settings.set("controls", m);
                            }}
                          />
                          {m === "orbit" ? "Orbit (Z stays up)" : "Trackball (free rotation)"}
                        </label>
                      ))}
                      <h3>Theme</h3>
                      {(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
                        <label key={t}>
                          <input
                            type="radio"
                            name="theme"
                            checked={themeChoice === t}
                            onChange={() => {
                              setThemeChoice(t);
                              settings.set("theme", t);
                            }}
                          />
                          {t[0].toUpperCase() + t.slice(1)}
                        </label>
                      ))}
                      <p className="muted small">Views: 0 Iso · 7 Top · 1 Front · 3 Right · F Fit · P projection</p>
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
              <BottomPanel open={panelOpen} tab={tab} log={state.log} problems={state.problems} onTab={setTab} onToggle={togglePanel} />
            </>
          ) : (
            <Welcome
              engineReady={!!state.engine}
              engineError={state.engineError}
              opening={state.opening}
              openError={state.openError}
              onOpen={pickAndOpen}
            />
          )}
        </main>
      </div>
      <StatusBar project={state.project} engine={state.engine} engineError={state.engineError} />
    </div>
  );
}
