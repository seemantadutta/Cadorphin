import type { EngineInfo, ProjectInfo } from "../backend/types";
import { volumeText } from "./format";

interface Props {
  project: ProjectInfo | null;
  engine: EngineInfo | null;
  engineError: string | null;
  onPrinter: () => void;
}

export function StatusBar({ project, engine, engineError, onPrinter }: Props) {
  return (
    <footer className="statusbar mono">
      <span className="status-path" title={project?.root}>
        {project ? <span className="ok-text">●</span> : <span className="muted">○</span>} {project ? `Watching ${project.root}` : "No project open"}
      </span>
      {project && (
        <button className="status-printer" onClick={onPrinter} title="Change the printer (Preferences)">
          Printer: {project.profile.name} · {volumeText(project.profile)}
        </button>
      )}
      <span>
        {engine ? `cadkit ${engine.cadkit} · build123d ${engine.build123d}` : engineError ? <span className="error-text">CAD engine not available</span> : "Starting CAD engine…"}
      </span>
      {project && <span>Units: {project.units}</span>}
    </footer>
  );
}
