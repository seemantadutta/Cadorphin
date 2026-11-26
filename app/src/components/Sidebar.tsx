import type { BodyInfo, ParamSpec, ParamValue, ProjectInfo } from "../backend/types";
import { ParamField } from "./ParamField";

interface Props {
  project: ProjectInfo;
  bodies: BodyInfo[];
  hidden: Set<string>;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
  onToggleBody: (name: string) => void;
  onSetParam: (name: string, value: ParamValue) => void;
}

export function Sidebar({ project, bodies, hidden, activeFile, onOpenFile, onToggleBody, onSetParam }: Props) {
  const groups = new Map<string, ParamSpec[]>();
  for (const p of project.params) {
    const g = p.group ?? "Parameters";
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }

  return (
    <aside className="sidebar">
      <section>
        <h2>PROJECT</h2>
        <ul className="files mono">
          {project.files.map((f) => (
            <li key={f}>
              <button className={f === activeFile ? "active" : ""} onClick={() => onOpenFile(f)} title={`Show ${f} (read-only)`}>
                {f}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>PARAMETERS</h2>
        {project.params_error && <p className="error-text">{project.params_error}</p>}
        {!project.params.length && !project.params_error && <p className="muted small">No parameters in params.toml</p>}
        {[...groups.entries()].map(([group, params]) => (
          <div key={group} className="param-group">
            {groups.size > 1 && <h3>{group}</h3>}
            {params.map((p) => (
              <ParamField key={p.name} spec={p} onCommit={onSetParam} />
            ))}
          </div>
        ))}
      </section>

      <section>
        <h2>BODIES</h2>
        {!bodies.length && <p className="muted small">No bodies yet</p>}
        <ul className="bodies">
          {bodies.map((b) => (
            <li key={b.name}>
              <label title={b.valid ? "Show or hide" : "Not a valid solid; see Problems"}>
                <input type="checkbox" checked={!hidden.has(b.name)} onChange={() => onToggleBody(b.name)} />
                <span className="swatch" style={{ background: b.color ?? "#B8BCC4" }} />
                <span className={b.valid ? "body-name" : "body-name invalid"}>{b.name}</span>
                <span className="muted small">{b.material ?? ""}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
