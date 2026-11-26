import { useEffect, useMemo, useState } from "react";

import { useBackend } from "../backend/context";
import type { PrinterProfile, ProjectInfo } from "../backend/types";
import { settings, type ThemeChoice } from "../settings";
import type { ControlsMode } from "../viewer/Viewer";
import { Dialog } from "./Dialog";
import { volumeText } from "./format";

export type PrefsSection = "printer" | "appearance" | "viewer" | "terminals";

const SECTIONS: { id: PrefsSection; label: string }[] = [
  { id: "printer", label: "Printer" },
  { id: "appearance", label: "Appearance" },
  { id: "viewer", label: "Viewer" },
  { id: "terminals", label: "Terminals" },
];

interface Props {
  initialSection: PrefsSection;
  project: ProjectInfo | null;
  theme: ThemeChoice;
  controls: ControlsMode;
  onTheme: (t: ThemeChoice) => void;
  onControls: (c: ControlsMode) => void;
  onPrinter: (id: string) => Promise<void>;
  onClose: () => void;
}

export function PreferencesDialog(props: Props) {
  const [section, setSection] = useState<PrefsSection>(props.initialSection);
  return (
    <Dialog title="Preferences" onClose={props.onClose} className="prefs">
      <div className="prefs-body">
        <nav className="prefs-nav" aria-label="Preferences sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className={section === s.id ? "active" : ""} aria-current={section === s.id} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="prefs-content">
          {section === "printer" && <PrinterSection project={props.project} onPrinter={props.onPrinter} />}
          {section === "appearance" && (
            <section>
              <h3>Theme</h3>
              {(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
                <label key={t} className="choice">
                  <input type="radio" name="theme" checked={props.theme === t} onChange={() => props.onTheme(t)} />
                  {t === "system" ? "Match the system" : t[0].toUpperCase() + t.slice(1)}
                </label>
              ))}
            </section>
          )}
          {section === "terminals" && <TerminalsSection />}
          {section === "viewer" && (
            <section>
              <h3>Mouse controls</h3>
              {(["orbit", "trackball"] as ControlsMode[]).map((m) => (
                <label key={m} className="choice">
                  <input type="radio" name="controls" checked={props.controls === m} onChange={() => props.onControls(m)} />
                  {m === "orbit" ? "Orbit (Z stays up)" : "Trackball (free rotation)"}
                </label>
              ))}
              <h3>Keyboard</h3>
              <p className="muted small">With the view focused: 0 Iso · 7 Top · 1 Front · 3 Right · F Fit · P switch projection</p>
            </section>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function TerminalsSection() {
  const [confirm, setConfirm] = useState(settings.get("confirmCloseTerminals"));
  return (
    <section>
      <h3>Leaving a project</h3>
      <label className="choice">
        <input
          type="checkbox"
          checked={confirm}
          onChange={(e) => {
            setConfirm(e.target.checked);
            settings.set("confirmCloseTerminals", e.target.checked);
          }}
        />
        Ask before closing terminals I have used
      </label>
      <p className="muted small">
        Opening another project, starting a new one or closing the project closes its terminals, and stops anything running in them,
        such as an agent. Its conversation is kept and resumes when you reopen the project.
      </p>
    </section>
  );
}

function PrinterSection({ project, onPrinter }: { project: ProjectInfo | null; onPrinter: (id: string) => Promise<void> }) {
  const backend = useBackend();
  const [profiles, setProfiles] = useState<PrinterProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    backend.listProfiles().then(setProfiles, (e) => setLoadError(String(e)));
  }, [backend]);

  const groups = useMemo(() => {
    const byVendor = new Map<string, PrinterProfile[]>();
    for (const p of profiles ?? []) {
      const v = p.vendor || "Other";
      byVendor.set(v, [...(byVendor.get(v) ?? []), p]);
    }
    // Real printers first, the generic fallbacks last.
    return [...byVendor.entries()].sort(([a], [b]) => Number(a === "Generic") - Number(b === "Generic") || a.localeCompare(b));
  }, [profiles]);

  if (!project) {
    return (
      <section>
        <h3>Printer</h3>
        <p className="muted">Open a project to choose its printer. Each project keeps its printer in its own project.toml.</p>
      </section>
    );
  }

  const current = project.profile.id;
  const choose = async (id: string) => {
    if (id === current || saving) return;
    setSaving(id);
    setError(null);
    try {
      await onPrinter(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section>
      <h3>Printer for {project.name}</h3>
      <p className="muted small">
        Sets the build volume that <code>cadkit check</code> tests against. It is saved in this project's <code>project.toml</code>, so
        agents in the terminal use the same printer.
      </p>
      {loadError && <p className="error-text small">{loadError}</p>}
      {!profiles && !loadError && <p className="muted small">Loading printers…</p>}
      <div className="printer-list" role="radiogroup" aria-label="Printer">
        {groups.map(([vendor, list]) => (
          <div key={vendor} className="printer-group">
            <div className="printer-vendor">{vendor}</div>
            {list.map((p) => {
              const selected = p.id === current;
              return (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={selected}
                  className={selected ? "printer selected" : "printer"}
                  disabled={!!saving}
                  onClick={() => void choose(p.id)}
                >
                  <span className="radio-dot" aria-hidden="true" />
                  <span className="printer-name">{p.name}</span>
                  <span className="printer-volume mono">{saving === p.id ? "Saving…" : volumeText(p)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {error && <p className="error-text small">{error}</p>}
    </section>
  );
}
