import { useEffect, useRef, useState } from "react";

import { settings } from "../settings";
import { Viewer, type ControlsMode, type Projection, type ViewName, type ViewerBody, type ViewerTheme } from "./Viewer";

interface Props {
  bodies: ViewerBody[];
  hidden: Set<string>;
  bboxText: string | null;
  theme: "light" | "dark";
  controlsMode: ControlsMode;
  overlay?: React.ReactNode;
}

function readTheme(): ViewerTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { background: v("--viewer-bg"), grid: v("--viewer-grid"), gridCenter: v("--viewer-grid-center"), edge: v("--viewer-edge") };
}

const VIEWS: [ViewName, string, string][] = [
  ["iso", "Iso", "0"],
  ["top", "Top", "7"],
  ["front", "Front", "1"],
  ["right", "Right", "3"],
];

export function ViewerPane({ bodies, hidden, bboxText, theme, controlsMode, overlay }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [projection, setProjection] = useState<Projection>(settings.get("projection"));
  const [hint, setHint] = useState(!settings.get("hintDismissed"));

  useEffect(() => {
    const v = new Viewer(host.current!, readTheme());
    viewer.current = v;
    v.setProjection(settings.get("projection"));
    return () => {
      v.dispose();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    viewer.current?.setBodies(bodies).catch((e) => console.error("Could not load model", e));
  }, [bodies]);

  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    for (const b of bodies) v.setVisible(b.name, !hidden.has(b.name));
  }, [hidden, bodies]);

  useEffect(() => {
    // CSS variables change with the theme; read them after the browser applies the new attribute.
    requestAnimationFrame(() => viewer.current?.setTheme(readTheme()));
  }, [theme]);

  useEffect(() => viewer.current?.setControlsMode(controlsMode), [controlsMode]);

  const chooseProjection = (p: Projection) => {
    viewer.current?.setProjection(p);
    setProjection(p);
    settings.set("projection", p);
  };

  // Keyboard: 0/7/1/3 views (numpad-style), F fit, P toggles projection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest("input, textarea, [contenteditable]")) return;
      const view = VIEWS.find(([, , key]) => key === e.key);
      if (view) viewer.current?.setView(view[0]);
      else if (e.key === "f" || e.key === "F") viewer.current?.fit();
      else if (e.key === "p" || e.key === "P") chooseProjection(viewer.current?.projection === "perspective" ? "orthographic" : "perspective");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="viewer-pane">
      <div className="toolbar" role="toolbar" aria-label="View">
        {VIEWS.map(([name, label, key]) => (
          <button key={name} className="btn" onClick={() => viewer.current?.setView(name)} title={`${label} view (${key})`}>
            {label}
          </button>
        ))}
        <span className="sep" />
        <div className="segmented" role="group" aria-label="Projection">
          <button aria-pressed={projection === "perspective"} onClick={() => chooseProjection("perspective")} title="Perspective (P)">
            Perspective
          </button>
          <button aria-pressed={projection === "orthographic"} onClick={() => chooseProjection("orthographic")} title="Orthographic (P)">
            Orthographic
          </button>
        </div>
        <span className="sep" />
        <button className="btn" onClick={() => viewer.current?.fit()} title="Fit model in view (F)">
          Fit
        </button>
        <div className="grow" />
        {bboxText && (
          <span className="mono muted" title="Bounding box of the visible bodies">
            {bboxText}
          </span>
        )}
      </div>
      <div className="viewport" ref={host}>
        {hint && (
          <div className="hint">
            {controlsMode === "orbit"
              ? "Left-drag to rotate · Right-, middle- or Shift-drag to pan · Scroll to zoom · Double-click to set the orbit point"
              : "Left-drag to rotate freely · Right- or middle-drag to pan · Scroll to zoom · Double-click to set the orbit point"}
            <button
              className="hint-close"
              aria-label="Dismiss hint"
              onClick={() => {
                setHint(false);
                settings.set("hintDismissed", true);
              }}
            >
              ×
            </button>
          </div>
        )}
        {overlay}
      </div>
    </div>
  );
}
