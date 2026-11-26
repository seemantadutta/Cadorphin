import { useEffect, useRef, useState } from "react";

import type { Problem } from "../backend/types";
import { settings } from "../settings";
import type { LogEntry } from "../state/useProject";
import { KNOWN_AGENTS } from "../terminal/agents";
import { TerminalView } from "../terminal/TerminalView";

export interface TermTab {
  key: string;
  label: string;
  command?: string;
  exited: boolean;
  /** The user typed in it, or it was started with a command: closing it may interrupt work. */
  used: boolean;
}

/** "log", "problems", or "term:<key>". */
export type BottomTab = string;

interface Props {
  open: boolean;
  tab: BottomTab;
  log: LogEntry[];
  problems: Problem[];
  terminals: TermTab[];
  theme: "light" | "dark";
  onTab: (t: BottomTab) => void;
  onToggle: () => void;
  onNewTerminal: (command?: string, label?: string) => void;
  /** Starts a known agent (terminal/agents.ts) with a new session; it becomes the project's agent. */
  onStartAgent: (id: string) => void;
  onCloseTerminal: (key: string) => void;
  onTerminalExit: (key: string) => void;
  onTerminalInput: (key: string) => void;
  onTerminalError: (message: string) => void;
}

const MIN_H = 120;

function time(d: Date) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function BottomPanel(props: Props) {
  const { open, tab, log, problems, terminals, theme, onTab, onToggle } = props;
  const [height, setHeight] = useState(settings.get("bottomPanelHeight"));
  const [menu, setMenu] = useState(false);
  const [custom, setCustom] = useState("");
  const logEnd = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && tab === "log") logEnd.current?.scrollIntoView({ block: "end" });
  }, [log, open, tab]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => {
      const max = window.innerHeight * 0.75;
      setHeight(Math.round(Math.min(max, Math.max(MIN_H, startH + (startY - ev.clientY)))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setHeight((h) => {
        settings.set("bottomPanelHeight", h);
        return h;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const select = (id: BottomTab) => {
    if (open && tab === id) onToggle();
    else {
      onTab(id);
      if (!open) onToggle();
    }
  };

  const launch = (command?: string, label?: string) => {
    setMenu(false);
    setCustom("");
    props.onNewTerminal(command, label);
  };

  const recent = settings.get("customCommands");

  return (
    <section className={open ? "bottom open" : "bottom"} style={open ? { height } : undefined}>
      {open && <div className="resize-handle" onPointerDown={startResize} title="Drag to resize" />}
      <div className="tabs" role="tablist">
        {terminals.map((t) => {
          const id = `term:${t.key}`;
          const selected = open && tab === id;
          return (
            <span key={t.key} className={`tab term-tab${selected ? " active" : ""}${t.exited ? " exited" : ""}`}>
              <button role="tab" aria-selected={selected} onClick={() => select(id)} title={t.command ? `Runs: ${t.command}` : "Shell in the project folder"}>
                {t.label}
              </button>
              <button className="close" aria-label={`Close ${t.label}`} title="Close (stops what is running in it)" onClick={() => props.onCloseTerminal(t.key)}>
                ×
              </button>
            </span>
          );
        })}
        <div className="new-term" ref={menuRef}>
          <button className="icon-btn" aria-label="New terminal" title="New terminal" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            +
          </button>
          {menu && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => launch()}>
                New terminal
              </button>
              <div className="menu-sep" />
              <div className="menu-label">Start an agent in a new terminal</div>
              {KNOWN_AGENTS.map((a) => (
                <button
                  key={a.id}
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    props.onStartAgent(a.id);
                  }}
                >
                  {a.label} <span className="mono muted">{a.command}</span>
                </button>
              ))}
              {recent.map((c) => (
                <button key={c} role="menuitem" onClick={() => launch(c, c.split(" ")[0])}>
                  <span className="mono">{c}</span>
                </button>
              ))}
              <div className="menu-sep" />
              <form
                className="menu-custom"
                onSubmit={(e) => {
                  e.preventDefault();
                  const c = custom.trim();
                  if (!c) return;
                  settings.set("customCommands", [c, ...recent.filter((x) => x !== c)].slice(0, 5));
                  launch(c, c.split(" ")[0]);
                }}
              >
                <input className="mono" placeholder="Custom command…" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Custom command" />
              </form>
            </div>
          )}
        </div>
        <span className="sep" />
        <button role="tab" aria-selected={open && tab === "log"} className={open && tab === "log" ? "tab active" : "tab"} onClick={() => select("log")}>
          Build log
        </button>
        <button
          role="tab"
          aria-selected={open && tab === "problems"}
          className={open && tab === "problems" ? "tab active" : "tab"}
          onClick={() => select("problems")}
        >
          Problems ({problems.length})
        </button>
        <div className="grow" />
        <button className="icon-btn" onClick={onToggle} aria-label={open ? "Collapse panel" : "Expand panel"} title={open ? "Collapse" : "Expand"}>
          {open ? "▾" : "▴"}
        </button>
      </div>
      {/* Terminals stay mounted while hidden so their sessions keep running. */}
      <div className="panel-body-wrap" style={{ display: open ? "flex" : "none" }}>
        {terminals.map((t) => (
          <TerminalView
            key={t.key}
            command={t.command}
            active={open && tab === `term:${t.key}`}
            theme={theme}
            onReady={() => {}}
            onExit={() => props.onTerminalExit(t.key)}
            onFirstInput={() => props.onTerminalInput(t.key)}
            onError={props.onTerminalError}
          />
        ))}
        {tab === "log" && (
          <div className="panel-body mono">
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
          </div>
        )}
        {tab === "problems" && (
          <div className="panel-body mono">
            <div className="problems">
              {!problems.length && <div className="ok-text">✓ No problems found</div>}
              {problems.map((p, i) => (
                <div key={i} className={`problem ${p.severity}`}>
                  <span className="sev">{p.severity === "error" ? "✗" : "⚠"}</span>
                  <span>{p.message}</span>
                  {p.location && <span className="muted"> near ({p.location.map((v) => v.toFixed(1)).join(", ")})</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {!terminals.length && tab.startsWith("term:") && (
          <div className="panel-body muted">
            No terminal open. Use <strong>+</strong> to open one in the project folder.
          </div>
        )}
      </div>
    </section>
  );
}
