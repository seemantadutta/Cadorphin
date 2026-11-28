import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import type { BodyInfo, ParamSpec, ParamValue, ProjectInfo } from "../backend/types";
import { settings } from "../settings";
import { ParamField } from "./ParamField";

interface Props {
  project: ProjectInfo;
  bodies: BodyInfo[];
  hidden: Set<string>;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
  onToggleBody: (name: string) => void;
  onSetParam: (name: string, value: ParamValue) => void;
  /** Opens the export dialog with only this body ticked. */
  onExportBody: (name: string) => void;
}

/** Folded/unfolded state for every node of the tree, remembered across launches. */
function useFolds() {
  const [folds, setFolds] = useState<Record<string, boolean>>(() => settings.get("sidebarFolds"));
  const isOpen = (id: string, byDefault = true) => folds[id] ?? byDefault;
  const toggle = (id: string, byDefault = true) =>
    setFolds((f) => {
      const next = { ...f, [id]: !(f[id] ?? byDefault) };
      settings.set("sidebarFolds", next);
      return next;
    });
  return { isOpen, toggle };
}

function Node({
  label,
  count,
  open,
  onToggle,
  level,
  extra,
  onContextMenu,
  children,
}: {
  label: ReactNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  level: 1 | 2;
  extra?: ReactNode;
  onContextMenu?: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <div className={`tree-node level-${level}`}>
      <div className="tree-row" onContextMenu={onContextMenu}>
        <button className="tree-toggle" aria-expanded={open} onClick={onToggle}>
          <span className={open ? "chevron open" : "chevron"} aria-hidden="true" />
          <span className="tree-label">{label}</span>
          {count !== undefined && <span className="tree-count">{count}</span>}
        </button>
        {extra}
      </div>
      {open && <div className="tree-children">{children}</div>}
    </div>
  );
}

const mm = (v: number) => `${+v.toFixed(1)}`;

/** The body row's right-click menu; closes on any click, Esc, scroll or resize. */
function BodyMenu({ x, y, name, onExport, onClose }: { x: number; y: number; name: string; onExport: () => void; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onClose);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onClose);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);
  return (
    <div className="context-menu" role="menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <button
        role="menuitem"
        autoFocus
        onClick={() => {
          onClose();
          onExport();
        }}
      >
        Export {name}…
      </button>
    </div>
  );
}

export function Sidebar({ project, bodies, hidden, activeFile, onOpenFile, onToggleBody, onSetParam, onExportBody }: Props) {
  const { isOpen, toggle } = useFolds();
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const groups = new Map<string, ParamSpec[]>();
  for (const p of project.params) {
    const g = p.group ?? "Parameters";
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }

  return (
    <aside className="sidebar tree">
      {menu && <BodyMenu {...menu} onExport={() => onExportBody(menu.name)} onClose={() => setMenu(null)} />}
      <Node label="Project" count={project.files.length} level={1} open={isOpen("project")} onToggle={() => toggle("project")}>
        <ul className="files mono">
          {project.files.map((f) => (
            <li key={f}>
              <button className={f === activeFile ? "active" : ""} onClick={() => onOpenFile(f)} title={`Show ${f} (read-only)`}>
                {f}
              </button>
            </li>
          ))}
        </ul>
      </Node>

      <Node label="Bodies" count={bodies.length} level={1} open={isOpen("bodies")} onToggle={() => toggle("bodies")}>
        {!bodies.length && <p className="muted small tree-empty">No bodies yet</p>}
        {bodies.map((b) => {
          const id = `body:${b.name}`;
          return (
            <Node
              key={b.name}
              level={2}
              open={isOpen(id, false)}
              onToggle={() => toggle(id, false)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, name: b.name });
              }}
              label={
                <>
                  <span className="swatch" style={{ background: b.color ?? "#B8BCC4" }} />
                  <span className={b.valid ? "body-name" : "body-name invalid"}>{b.name}</span>
                </>
              }
              extra={
                <input
                  type="checkbox"
                  className="body-visible"
                  checked={!hidden.has(b.name)}
                  onChange={() => onToggleBody(b.name)}
                  aria-label={`Show ${b.name}`}
                  title={b.valid ? "Show or hide" : "Not a valid solid; see Problems"}
                />
              }
            >
              <dl className="body-details small">
                <dt>Material</dt>
                <dd>{b.material ?? "—"}</dd>
                <dt>Size</dt>
                <dd className="mono">{b.bbox.map(mm).join(" × ")} mm</dd>
                <dt>Volume</dt>
                <dd className="mono">{(b.volume_mm3 / 1000).toFixed(2)} cm³</dd>
                {!b.valid && (
                  <>
                    <dt>Status</dt>
                    <dd className="error-text">Not a valid solid</dd>
                  </>
                )}
              </dl>
              <button className="link small body-export" onClick={() => onExportBody(b.name)}>
                Export this body…
              </button>
            </Node>
          );
        })}
      </Node>

      <Node label="Parameters" count={project.params.length} level={1} open={isOpen("params")} onToggle={() => toggle("params")}>
        {project.params_error && <p className="error-text tree-empty">{project.params_error}</p>}
        {!project.params.length && !project.params_error && <p className="muted small tree-empty">No parameters in params.toml</p>}
        {groups.size <= 1
          ? project.params.map((p) => <ParamField key={p.name} spec={p} onCommit={onSetParam} />)
          : [...groups.entries()].map(([group, params]) => (
              <Node
                key={group}
                label={group}
                count={params.length}
                level={2}
                open={isOpen(`group:${group}`)}
                onToggle={() => toggle(`group:${group}`)}
              >
                {params.map((p) => (
                  <ParamField key={p.name} spec={p} onCommit={onSetParam} />
                ))}
              </Node>
            ))}
      </Node>
    </aside>
  );
}
