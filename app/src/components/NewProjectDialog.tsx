import { useEffect, useMemo, useState } from "react";

import { useBackend } from "../backend/context";
import type { NewProjectOptions, PrinterProfile, ProjectTemplate } from "../backend/types";
import { settings } from "../settings";
import { KNOWN_AGENTS } from "../terminal/agents";
import { Dialog } from "./Dialog";
import { volumeText } from "./format";

const CUSTOM = "__custom";

interface Props {
  /** `agent` is an agent id from terminal/agents.ts ("custom:<command>" for others), or null for a plain terminal. */
  onCreate: (opts: NewProjectOptions, agent: string | null) => Promise<void>;
  onClose: () => void;
}

const BAD_CHARS = /[\\/:*?"<>|]/;

/** Mirrors valid_folder_name() in lib.rs, so mistakes show while typing. */
function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name";
  if (n === "." || n === "..") return "Choose another name";
  const bad = n.match(BAD_CHARS);
  if (bad) return `A folder name cannot contain ${bad[0]}`;
  if (/[. ]$/.test(n)) return "A folder name cannot end with a dot or a space";
  return null;
}

function joinPath(parent: string, name: string) {
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent.replace(/[\\/]+$/, "") + sep + name.trim();
}

/** Until a folder has been chosen here, suggest the one the most recent project lives in. */
function parentOf(path: string | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : null;
}

export function NewProjectDialog({ onCreate, onClose }: Props) {
  const backend = useBackend();
  const [name, setName] = useState("my-part");
  const [parent, setParent] = useState<string | null>(() => settings.get("projectsDir") ?? parentOf(settings.get("recentProjects")[0]));
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [template, setTemplate] = useState("empty"); // start with nothing; the agent builds from the brief
  const [profiles, setProfiles] = useState<PrinterProfile[]>([]);
  const [profile, setProfile] = useState(settings.get("lastPrinter"));
  const [description, setDescription] = useState("");
  const savedAgent = settings.get("newProjectAgent");
  const savedCustom = savedAgent.startsWith("custom:") ? savedAgent.slice("custom:".length) : "";
  const savedKnown = KNOWN_AGENTS.some((a) => a.id === savedAgent) ? savedAgent : "";
  const [agentChoice, setAgentChoice] = useState(savedCustom ? CUSTOM : savedKnown);
  const [customCommand, setCustomCommand] = useState(savedCustom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    backend.listTemplates().then(
      (t) => {
        setTemplates(t);
        if (t.length && !t.some((x) => x.id === "empty")) setTemplate(t[0].id);
      },
      (e) => setError(String(e)),
    );
    backend.listProfiles().then(
      (p) => {
        setProfiles(p);
        setProfile((cur) => (p.some((x) => x.id === cur) ? cur : ((p.find((x) => x.id === "generic-256") ?? p[0])?.id ?? cur)));
      },
      (e) => setError(String(e)),
    );
  }, [backend]);

  const groups = useMemo(() => {
    const m = new Map<string, PrinterProfile[]>();
    for (const p of profiles) m.set(p.vendor || "Other", [...(m.get(p.vendor || "Other") ?? []), p]);
    return [...m.entries()].sort(([a], [b]) => Number(a === "Generic") - Number(b === "Generic") || a.localeCompare(b));
  }, [profiles]);

  const problem = nameProblem(name);
  const agent: string | null = agentChoice === CUSTOM ? (customCommand.trim() ? `custom:${customCommand.trim()}` : null) : agentChoice || null;
  const canCreate =
    !busy && !problem && !!parent && templates.length > 0 && profiles.length > 0 && (agentChoice !== CUSTOM || !!agent);

  const browse = async () => {
    const picked = await backend.pickFolder("Choose where to create the project", parent ?? undefined);
    if (picked) setParent(picked);
  };

  const create = async () => {
    if (!canCreate || !parent) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ parent, name: name.trim(), template, profile, description: description.trim() || undefined }, agent);
      settings.set("projectsDir", parent);
      settings.set("lastPrinter", profile);
      settings.set("newProjectAgent", agent ?? "");
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title="New project" onClose={onClose} className="newproj">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />
          {problem && <small className="error-text">{problem}</small>}
        </label>

        <label className="field">
          <span>
            What is it for? <span className="muted">(optional)</span>
          </span>
          <textarea
            className="text-input textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="e.g. A wall-mounted case for an Adafruit Feather with a LiPo battery, a USB-C opening and two buttons on the lid."
          />
          <small className="muted">
            Added to CLAUDE.md, AGENTS.md and GEMINI.md as a design brief, after the generated rules, so your agent starts out knowing
            what the design is for.
          </small>
        </label>

        <div className="field">
          <span>Location</span>
          <div className="row">
            <input className="text-input mono" value={parent ?? ""} readOnly placeholder="Choose a folder…" onClick={() => void browse()} />
            <button type="button" className="btn" onClick={() => void browse()}>
              Browse…
            </button>
          </div>
          {parent && !problem && <small className="muted mono">Creates {joinPath(parent, name)}</small>}
        </div>

        <fieldset className="field">
          <legend>Template</legend>
          {templates.map((t) => (
            <label key={t.id} className={template === t.id ? "template selected" : "template"}>
              <input type="radio" name="template" checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <span>
                <strong>{t.id[0].toUpperCase() + t.id.slice(1)}</strong>
                {t.description && <span className="muted small"> · {t.description}</span>}
              </span>
            </label>
          ))}
        </fieldset>

        <label className="field">
          <span>Printer</span>
          <select className="text-input" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {groups.map(([vendor, list]) => (
              <optgroup key={vendor} label={vendor}>
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({volumeText(p)})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <small className="muted">You can change it later in Preferences.</small>
        </label>

        <label className="field">
          <span>Start in the terminal</span>
          <select className="text-input" value={agentChoice} onChange={(e) => setAgentChoice(e.target.value)}>
            <option value="">A plain terminal (no agent)</option>
            {KNOWN_AGENTS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.command})
              </option>
            ))}
            <option value={CUSTOM}>Another command…</option>
          </select>
          {agentChoice === CUSTOM && (
            <input
              className="text-input mono"
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              placeholder="Command to run, e.g. opencode"
              spellCheck={false}
              aria-label="Command to run"
            />
          )}
          <small className="muted">
            Opens in the project folder once the project is created, and again, resuming the last session, whenever you reopen the
            project. The agent must be installed already.
          </small>
        </label>

        {error && <p className="error-text small">{error}</p>}

        <footer className="dialog-foot flush">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canCreate}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
