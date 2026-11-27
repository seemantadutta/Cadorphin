import { useEffect, useState } from "react";

import { APP_NAME } from "../config";
import type { BuildStatus } from "../state/useProject";

interface Props {
  projectName: string | null;
  status: BuildStatus;
  lastBuiltAt: Date | null;
  bodyCount: number;
  errorCount: number;
  checking: boolean;
  onCheck: () => void;
  onExport: () => void;
  onOpen: () => void;
}

function ago(d: Date, now: number) {
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 2 21 7v10l-9 5-9-5V7z" />
      <path d="M3 7l9 5 9-5M12 12v10" />
    </svg>
  );
}

export function TopBar({ projectName, status, lastBuiltAt, bodyCount, errorCount, checking, onCheck, onExport, onOpen }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  let pill: { cls: string; text: string } | null = null;
  if (status === "building") pill = { cls: "pill building", text: "Building…" };
  else if (status === "error") pill = { cls: "pill error", text: "Build failed · see Build log" };
  else if (status === "built" && lastBuiltAt) {
    const extra = errorCount ? ` · ${errorCount} problem${errorCount === 1 ? "" : "s"}` : ` · ${bodyCount} bodies`;
    pill = { cls: errorCount ? "pill warn" : "pill ok", text: `Built ${ago(lastBuiltAt, now)}${extra}` };
  }

  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <span className="app-name">{APP_NAME}</span>
        {projectName && (
          <>
            <span className="muted">/</span>
            <button className="project-name mono" onClick={onOpen} title="Open another project folder">
              {projectName}
            </button>
          </>
        )}
      </div>
      <div className="grow" />
      {pill && (
        <div className={pill.cls} role="status">
          <span className="dot" />
          {pill.text}
        </div>
      )}
      <button className="btn" onClick={onCheck} disabled={!projectName || checking} title="Full check: walls, small features, renders (Ctrl+Shift+C)">
        {checking ? "Checking…" : "Check"}
      </button>
      <button className="btn primary" onClick={onExport} disabled={!projectName || !bodyCount} title="Export STEP, STL or 3MF (Ctrl+Shift+E)">
        Export…
      </button>
    </header>
  );
}
