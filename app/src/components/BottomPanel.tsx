import { useEffect, useRef } from "react";

import type { Problem } from "../backend/types";
import type { LogEntry } from "../state/useProject";

export type BottomTab = "terminal" | "log" | "problems";

interface Props {
  open: boolean;
  tab: BottomTab;
  log: LogEntry[];
  problems: Problem[];
  onTab: (t: BottomTab) => void;
  onToggle: () => void;
}

function time(d: Date) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function BottomPanel({ open, tab, log, problems, onTab, onToggle }: Props) {
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && tab === "log") logEnd.current?.scrollIntoView({ block: "end" });
  }, [log, open, tab]);

  const tabs: [BottomTab, string][] = [
    ["terminal", "Terminal"],
    ["log", "Build log"],
    ["problems", `Problems (${problems.length})`],
  ];

  return (
    <section className={open ? "bottom open" : "bottom"}>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={open && tab === id}
            className={open && tab === id ? "tab active" : "tab"}
            onClick={() => (open && tab === id ? onToggle() : (onTab(id), !open && onToggle()))}
          >
            {label}
          </button>
        ))}
        <div className="grow" />
        <button className="icon-btn" onClick={onToggle} aria-label={open ? "Collapse panel" : "Expand panel"} title={open ? "Collapse" : "Expand"}>
          {open ? "▾" : "▴"}
        </button>
      </div>
      {open && (
        <div className="panel-body mono">
          {tab === "terminal" && (
            <div className="muted placeholder-text">
              The agent terminal arrives in M3. Until then, run your agent (for example <code>claude</code>) in a terminal in the project
              folder; this window rebuilds whenever it saves a file.
            </div>
          )}
          {tab === "log" && (
            <div className="log">
              {!log.length && <div className="muted">Nothing yet.</div>}
              {log.map((e, i) => (
                <div key={i} className={`log-line ${e.kind}`}>
                  <span className="log-time">{time(e.time)}</span>
                  <pre>{e.text}</pre>
                </div>
              ))}
              <div ref={logEnd} />
            </div>
          )}
          {tab === "problems" && (
            <div className="problems">
              {!problems.length && <div className="ok-text">✓ No problems found</div>}
              {problems.map((p, i) => (
                <div key={i} className={`problem ${p.severity}`}>
                  <span className="sev">{p.severity === "error" ? "✗" : "⚠"}</span>
                  <span>{p.message}</span>
                  {p.location && (
                    <span className="muted">
                      {" "}
                      near ({p.location.map((v) => v.toFixed(1)).join(", ")})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
