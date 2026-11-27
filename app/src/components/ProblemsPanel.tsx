import type { Problem } from "../backend/types";

interface Props {
  problems: Problem[];
  /** Renders from the last full check (project-relative PNG paths). */
  renders: string[];
  checking: boolean;
  active: number | null;
  onShow: (index: number) => void;
  onSend: (index: number) => void;
  onOpenRender: (path: string) => void;
  onCheck: () => void;
}

/** Messages often already say where ("near (x, y, z)"); add the location only when they don't. */
function locationText(p: Problem) {
  if (!p.location || /\((-?\d|\s)/.test(p.message)) return null;
  return ` near (${p.location.map((v) => v.toFixed(1)).join(", ")})`;
}

export function ProblemsPanel({ problems, renders, checking, active, onShow, onSend, onOpenRender, onCheck }: Props) {
  const errors = problems.filter((p) => p.severity === "error").length;
  return (
    <div className="panel-body problems-panel">
      <div className="problems-head small">
        {checking ? (
          <span className="muted">Checking… (walls, small features, renders)</span>
        ) : problems.length ? (
          <span>
            {errors ? <span className="error-text">{errors} blocking export</span> : <span className="muted">Nothing blocks export</span>}
            <span className="muted"> · click a problem to show it</span>
          </span>
        ) : (
          <span className="ok-text">✓ No problems found</span>
        )}
        <span className="grow" />
        {renders.length > 0 && (
          <span className="renders">
            <span className="muted">Renders:</span>
            {renders.map((r) => (
              <button key={r} className="link" onClick={() => onOpenRender(r)} title={r}>
                {r.split("/").pop()!.replace(/\.png$/, "")}
              </button>
            ))}
          </span>
        )}
        <button className="btn small-btn" onClick={onCheck} disabled={checking} title="Run the full check (Ctrl+Shift+C)">
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
      <ul className="problems mono">
        {problems.map((p, i) => (
          <li key={i} className={`problem ${p.severity}${active === i ? " active" : ""}`}>
            <button className="problem-main" onClick={() => onShow(i)} title={p.location ? "Show it in the view" : undefined}>
              <span className="sev">{p.severity === "error" ? "✗" : "⚠"}</span>
              <span className="problem-text">
                {p.message}
                {locationText(p) && <span className="muted">{locationText(p)}</span>}
              </span>
            </button>
            <button className="btn small-btn send" onClick={() => onSend(i)} title="Paste this problem into the agent's prompt (doesn't send it)">
              Send to agent
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
