import { Logo } from "./TopBar";

interface Props {
  engineReady: boolean;
  engineError: string | null;
  opening: boolean;
  openError: string | null;
  onOpen: () => void;
}

export function Welcome({ engineReady, engineError, opening, openError, onOpen }: Props) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <Logo />
        <h1>Open a project</h1>
        <p className="muted">
          A project is a folder with <code>model.py</code> and <code>params.toml</code>. Create one in a terminal:
        </p>
        <pre className="mono">cadkit new my-enclosure --template enclosure</pre>
        <button className="btn primary" onClick={onOpen} disabled={opening || !engineReady}>
          {opening ? "Opening…" : "Open folder…"}
        </button>
        {!engineReady && !engineError && <p className="muted small">Starting the CAD engine…</p>}
        {engineError && (
          <div className="setup-error">
            <strong>The CAD engine could not start.</strong>
            <pre>{engineError}</pre>
          </div>
        )}
        {openError && <p className="error-text">{openError}</p>}
      </div>
    </div>
  );
}
