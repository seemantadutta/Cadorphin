import { useState } from "react";

import { useBackend } from "../backend/context";
import type { BodyInfo, CheckReport, ExportResult, Problem } from "../backend/types";
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
  bodies: BodyInfo[];
  /** Bodies hidden in the viewer (for "Visible in viewer"). */
  hidden: Set<string>;
  /** Start with only this body ticked (the sidebar's "Export this body…"). The choice isn't remembered. */
  only?: string;
  /** Runs the full check and updates the Problems tab. */
  runCheck: () => Promise<CheckReport | null>;
  onExported: (outcome: ExportOutcome) => void;
  /** "Fix": close and show the Problems tab. */
  onFix: () => void;
  onClose: () => void;
}

type Phase = { kind: "setup" } | { kind: "checking" } | { kind: "exporting" } | { kind: "errors"; errors: Problem[]; warnings: Problem[] };

const DEFAULT_DIR = ".cad/export";

/** A problem matters for an export when every body it names is in it (an overlap with a body left out doesn't: they end up in different files). */
function concerns(p: Problem, chosen: Set<string>) {
  const names = p.bodies ?? (p.body ? [p.body] : []);
  return names.every((n) => chosen.has(n));
}

function initialPicks(key: string, bodies: BodyInfo[], only?: string) {
  if (only) return new Set([only]);
  const excluded = new Set(settings.get("exportExcluded")[key] ?? []);
  return new Set(bodies.map((b) => b.name).filter((n) => !excluded.has(n)));
}

export function ExportDialog({ projectRoot, bodies, hidden, only, runCheck, onExported, onFix, onClose }: Props) {
  const backend = useBackend();
  const key = projectKey(projectRoot);
  const [format, setFormat] = useState<ExportFormat>(settings.get("exportFormat"));
  const [folder, setFolder] = useState<string | null>(settings.get("exportDirs")[key] ?? null);
  const [choose, setChoose] = useState(() => Boolean(only) || settings.get("exportChooseBodies"));
  const [turnedOff, setTurnedOff] = useState(false);
  const [picked, setPicked] = useState(() => initialPicks(key, bodies, only));
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const [error, setError] = useState<string | null>(null);
  const busy = phase.kind === "checking" || phase.kind === "exporting";

  const allNames = bodies.map((b) => b.name);
  const chosen = choose ? picked : new Set(allNames);
  const chosenNames = allNames.filter((n) => chosen.has(n));
  const everything = chosenNames.length === allNames.length;

  const toggle = (name: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

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
    if (choose && !only) {
      const excluded = { ...settings.get("exportExcluded") };
      const left = allNames.filter((n) => !chosen.has(n));
      if (left.length) excluded[key] = left;
      else delete excluded[key];
      settings.set("exportExcluded", excluded);
    }
  };

  const doExport = async (force: boolean, warnings: Problem[]) => {
    setPhase({ kind: "exporting" });
    try {
      // All bodies: no list, so the file names stay <project>.3mf / .step
      const result = await backend.export(format, folder ?? undefined, force, everything ? undefined : chosenNames);
      if (!result.ok && !result.files.length) {
        setError(result.errors[0] ?? result.problems.find((p) => p.severity === "error")?.message ?? result.notes[0] ?? "The export failed");
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
    const report = await runCheck(); // all bodies, so the Problems tab stays complete
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
    const relevant = report.problems.filter((p) => concerns(p, chosen));
    const errors = relevant.filter((p) => p.severity === "error");
    const warnings = relevant.filter((p) => p.severity === "warning");
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
          if (chosenNames.length) void start();
        }}
      >
        {choose && (
          <fieldset className="field">
            <legend>
              Bodies <span className="muted small">({chosenNames.length} of {allNames.length})</span>
            </legend>
            <div className="export-body-actions small">
              <button type="button" className="link" onClick={() => setPicked(new Set(allNames))} disabled={busy}>
                All
              </button>
              <button type="button" className="link" onClick={() => setPicked(new Set())} disabled={busy}>
                None
              </button>
              <button type="button" className="link" onClick={() => setPicked(new Set(allNames.filter((n) => !hidden.has(n))))} disabled={busy}>
                Visible in viewer
              </button>
            </div>
            <div className="export-bodies">
              {bodies.map((b) => (
                <label key={b.name} className="choice">
                  <input type="checkbox" checked={picked.has(b.name)} onChange={() => toggle(b.name)} disabled={busy} />
                  <span className="swatch" style={{ background: b.color ?? "#B8BCC4" }} />
                  <span className="mono">{b.name}</span>
                  {b.material && <span className="muted small">{b.material}</span>}
                </label>
              ))}
            </div>
            {!only && (
              <button
                type="button"
                className="link small"
                onClick={() => {
                  settings.set("exportChooseBodies", false);
                  setChoose(false);
                  setTurnedOff(true);
                }}
                disabled={busy}
              >
                Always export all bodies
              </button>
            )}
          </fieldset>
        )}
        {turnedOff && <p className="muted small">All bodies will be exported. To choose again, turn on Preferences → Export → Ask which bodies to export.</p>}

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

        <p className="muted small">
          The full check runs first. Errors on the exported bodies stop the export unless you choose to export anyway.
          {!everything && chosenNames.length === 1 && format !== "stl" && ` The file is named after the body, so it doesn't replace the full export.`}
        </p>
        {error && <p className="error-text small">{error}</p>}

        <footer className="dialog-foot flush">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || !chosenNames.length}
            title={chosenNames.length ? undefined : "Tick at least one body"}
            autoFocus
          >
            {phase.kind === "checking" ? "Checking…" : phase.kind === "exporting" ? "Exporting…" : "Export"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
