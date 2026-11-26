import { Logo } from "./TopBar";

interface Props {
  engineReady: boolean;
  engineError: string | null;
  opening: boolean;
  openError: string | null;
  recent: string[];
  onNew: () => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onForgetRecent: (path: string) => void;
}

function baseName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

export function Welcome({ engineReady, engineError, opening, openError, recent, onNew, onOpen, onOpenRecent, onForgetRecent }: Props) {
  const disabled = opening || !engineReady;
  return (
    <div className="welcome">
      <div className="welcome-card">
        <Logo />
        <h1>Start a project</h1>
        <p className="muted">
          A project is a folder with <code>model.py</code> and <code>params.toml</code>. Start from a template, or open a folder made
          with <code>cadkit new</code>.
        </p>
        <div className="welcome-actions">
          <button className="btn primary" onClick={onNew} disabled={disabled}>
            New project…
          </button>
          <button className="btn" onClick={onOpen} disabled={disabled}>
            {opening ? "Opening…" : "Open folder…"}
          </button>
        </div>
        {!engineReady && !engineError && <p className="muted small">Starting the CAD engine…</p>}
        {engineError && (
          <div className="setup-error">
            <strong>The CAD engine could not start.</strong>
            <pre>{engineError}</pre>
          </div>
        )}
        {openError && <p className="error-text small">{openError}</p>}
        {recent.length > 0 && (
          <div className="recent">
            <h3>Recent</h3>
            <ul>
              {recent.map((p) => (
                <li key={p}>
                  <button className="recent-open" onClick={() => onOpenRecent(p)} disabled={disabled} title={p}>
                    <span className="recent-name">{baseName(p)}</span>
                    <span className="recent-path mono">{p}</span>
                  </button>
                  <button
                    className="recent-forget"
                    onClick={() => onForgetRecent(p)}
                    aria-label={`Remove ${p} from the recent list`}
                    title="Remove from list"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
