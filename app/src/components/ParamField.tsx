import { useEffect, useState } from "react";

import type { ParamSpec, ParamValue } from "../backend/types";

interface Props {
  spec: ParamSpec;
  onCommit: (name: string, value: ParamValue) => void;
}

function decimals(n: number) {
  const s = String(n);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

/** Default arrow-key step: the parameter's `step`, else one unit in its last shown decimal place. */
function stepFor(spec: ParamSpec) {
  if (spec.step) return spec.step;
  const d = decimals(Number(spec.value));
  return d === 0 ? 1 : Math.pow(10, -Math.min(d, 2));
}

function rangeMessage(spec: ParamSpec, v: number): string | null {
  if (spec.min !== undefined && v < spec.min) return `Below the minimum (${spec.min}${spec.unit ? " " + spec.unit : ""})`;
  if (spec.max !== undefined && v > spec.max) return `Above the maximum (${spec.max}${spec.unit ? " " + spec.unit : ""})`;
  return null;
}

/** One editable parameter. Writes go through cadkit (params.toml), and the watcher rebuilds. */
export function ParamField({ spec, onCommit }: Props) {
  const label = spec.label ?? spec.name;
  const [text, setText] = useState(String(spec.value));
  const [focused, setFocused] = useState(false);

  // Follow outside changes (the agent or an editor changed params.toml) unless the user is typing.
  useEffect(() => {
    if (!focused) setText(String(spec.value));
  }, [spec.value, focused]);

  if (typeof spec.value === "boolean") {
    return (
      <label className="param" title={spec.name}>
        <span>{label}</span>
        <input type="checkbox" className="param-check" checked={spec.value} onChange={(e) => onCommit(spec.name, e.target.checked)} />
      </label>
    );
  }

  const numeric = typeof spec.value === "number";
  const num = Number(text.trim());
  const invalid = numeric && (text.trim() === "" || !Number.isFinite(num));
  const warning = numeric && !invalid ? rangeMessage(spec, num) : null;

  const commit = (raw: string) => {
    if (numeric) {
      const v = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(v)) {
        setText(String(spec.value)); // revert nonsense
        return;
      }
      if (v !== spec.value) onCommit(spec.name, v);
    } else if (raw !== spec.value) {
      onCommit(spec.name, raw);
    }
  };

  const nudge = (dir: 1 | -1, big: boolean) => {
    if (!numeric || invalid) return;
    const step = stepFor(spec) * (big ? 10 : 1);
    let v = num + dir * step;
    if (spec.min !== undefined) v = Math.max(spec.min, v);
    if (spec.max !== undefined) v = Math.min(spec.max, v);
    const d = Math.max(decimals(step), decimals(num));
    v = Number(v.toFixed(Math.min(d, 6)));
    setText(String(v));
    onCommit(spec.name, v);
  };

  const title = [spec.name, warning, numeric ? "Enter to apply · ↑/↓ to step (Shift ×10)" : "Enter to apply"].filter(Boolean).join(" · ");

  return (
    <label className="param" title={title}>
      <span>{label}</span>
      <span className={`param-input${invalid ? " invalid" : warning ? " warn" : ""}`}>
        <input
          className="mono"
          value={text}
          inputMode={numeric ? "decimal" : "text"}
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit(text);
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit(text);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setText(String(spec.value));
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
            }
          }}
        />
        {spec.unit && <span className="unit muted">{spec.unit}</span>}
      </span>
    </label>
  );
}
