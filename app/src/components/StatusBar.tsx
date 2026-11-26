import type { EngineInfo, ProjectInfo } from "../backend/types";

interface Props {
  project: ProjectInfo | null;
  engine: EngineInfo | null;
  engineError: string | null;
}

export function StatusBar({ project, engine, engineError }: Props) {
  return (
    <footer className="statusbar mono">
      <span title={project?.root}>
        {project ? <span className="ok-text">●</span> : <span className="muted">○</span>} {project ? `Watching ${project.root}` : "No project open"}
      </span>
      <span>
        {engine ? `cadkit ${engine.cadkit} · build123d ${engine.build123d}` : engineError ? <span className="error-text">CAD engine not available</span> : "Starting CAD engine…"}
      </span>
      {project && <span>Profile: {project.profile.id}</span>}
      {project && <span>Units: {project.units}</span>}
    </footer>
  );
}
