import { useState } from "react";

import { useBackend } from "../backend/context";
import type { CheckReport, ExportResult, Problem } from "../backend/types";
import { projectKey, settings, type ExportFormat } from "../settings";
import { Dialog } from "./Dialog";

const FORMATS: { id: ExportFormat; label: string; detail: string }[] = [
  { id: "3mf", label: "3MF", detail: "For slicers. One file, one named object per body, so each can get its own filament." },
  { id: "stl", label: "STL", detail: "One mesh file per body. Works with every slicer, but has no names or colours." },
  { id: "step", label: "STEP", detail: "Exact CAD geometry for other CAD programs. One file with every body." },
];

export interface ExportOutcome {
  result: ExportResult;
  warnings: Problem[];
  folder: string;
}

interface Props {
  projectRoot: string;
  /** Runs the full check and updates the Problems tab. */
  runCheck: () => Promise<CheckReport | null>;
  onExported: (outcome: ExportOutcome) => void;
  /** "Fix": close and show the Problems tab. */
  onFix: () => void;
  onClose: () => void;
}

type Phase = { kind: "setup" } | { kind: "checking" } | { kind: "exporting" } | { kind: "errors"; errors: Problem[]; warnings: Problem[] };

const DEFAULT_DIR = ".cad/export";

export function ExportDialog({ projectRoot, runCheck, onExported, onFix, onClose }: Props) {
  const backend = useBackend();
  const key = projectKey(projectRoot);
  const [format, setFormat] = useState<ExportFormat>(settings.get("exportFormat"));
  const [folder, setFolder] = useState<string | null>(settings.get("exportDirs")[key] ?? null);
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const [error, setError] = useState<string | null>(null);
  const busy = phase.kind === "checking" || phase.kind === "exporting";

  const browse = async () => {
    const picked = await backend.pickFolder("Export to which folder?", folder ?? undefined);
    if (picked) setFolder(picked);
  };

  const remember = () => {
    settings.set("exportFormat", format);
    const dirs = { ...settings.get("exportDirs") };
    if (folder) dirs[key] = folder;
    else delete dirs[key];
    settings.set("exportDirs", dirs);
  };

  const doExport = async (force: boolean, warnings: Problem[]) => {
    setPhase({ kind: "exporting" });
    try {
      const result = await backend.export(format, folder ?? undefined, force);
      if (!result.ok && !result.files.length) {
        setError(result.errors[0] ?? result.notes[0] ?? "The export failed");
        setPhase({ kind: "setup" });
        return;
      }
      remember();
      onExported({ result, warnings, folder: folder ?? DEFAULT_DIR });
      onClose();
    } catch (e) {
      setError(String(e));
      setPhase({ kind: "setup" });
    }
  };

  const start = async () => {
    setError(null);
    setPhase({ kind: "checking" });
    const report = await runCheck();
    if (!report) {
      setError("The check could not run; see the Build log.");
      setPhase({ kind: "setup" });
      return;
    }
    if (!report.bodies.length) {
      setError("There is nothing to export yet: the model has no bodies.");
      setPhase({ kind: "setup" });
      return;
    }
    const errors = report.problems.filter((p) => p.severity === "error");
    const warnings = report.problems.filter((p) => p.severity === "warning");
    if (errors.length) setPhase({ kind: "errors", errors, warnings });
    else await doExport(false, warnings);
  };

  if (phase.kind === "errors") {
    const n = phase.errors.length;
    return (
      <Dialog title={`${n} problem${n === 1 ? "" : "s"} must be fixed first`} onClose={onClose} className="export">
        <div className="confirm-body">
          <p>
            The check found {n === 1 ? "an error" : `${n} errors`} that would make the {format.toUpperCase()} unprintable or wrong
            {phase.warnings.length ? `, and ${phase.warnings.length} warning${phase.warnings.length === 1 ? "" : "s"}` : ""}.
          </p>
          <ul className="export-errors mono small">
            {phase.errors.map((p, i) => (
              <li key={i}>
                <span className="error-text">✗</span> {p.message}
              </li>
            ))}
          </ul>
        </div>
        <footer className="dialog-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => void doExport(true, phase.warnings)}>
            Export anyway
          </button>
          <button className="btn primary" onClick={onFix} autoFocus>
            Fix
          </button>
        </footer>
      </Dialog>
    );
  }

  return (
    <Dialog title="Export" onClose={busy ? () => {} : onClose} className="export">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <fieldset className="field">
          <legend>Format</legend>
          {FORMATS.map((f) => (
            <label key={f.id} className={format === f.id ? "template selected" : "template"}>
              <input type="radio" name="format" checked={format === f.id} onChange={() => setFormat(f.id)} disabled={busy} />
              <span>
                <strong>{f.label}</strong>
                <span className="muted small"> · {f.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="field">
          <span>Folder</span>
          <div className="row">
            <input className="text-input mono" value={folder ?? `${DEFAULT_DIR} (in the project)`} readOnly onClick={() => void browse()} disabled={busy} />
            <button type="button" className="btn" onClick={() => void browse()} disabled={busy}>
              Browse…
            </button>
          </div>
          {folder && (
            <button type="button" className="link small" onClick={() => setFolder(null)} disabled={busy}>
              Use the project's {DEFAULT_DIR} folder
            </button>
          )}
        </div>

        <p className="muted small">The full check runs first. Errors stop the export unless you choose to export anyway.</p>
        {error && <p className="error-text small">{error}</p>}

        <footer className="dialog-foot flush">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy} autoFocus>
            {phase.kind === "checking" ? "Checking…" : phase.kind === "exporting" ? "Exporting…" : "Export"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
