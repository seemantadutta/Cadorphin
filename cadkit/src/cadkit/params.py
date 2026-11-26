"""Load params.toml.

Two forms are accepted per entry:

    wall = 2.2                 # bare value

    [wall]                     # typed entry with GUI metadata
    value = 2.2
    unit = "mm"
    min = 0.8
    max = 5
    step = 0.1
    label = "Wall thickness"
    group = "Case"
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from .tomlcompat import tomllib

META_KEYS = {"value", "unit", "min", "max", "step", "label", "group"}


class ParamError(ValueError):
    pass


@dataclass
class ParamSpec:
    name: str
    value: Any
    unit: str | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    label: str | None = None
    group: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Params:
    """Attribute and item access to parameter values: p.wall or p["wall"]."""

    specs: dict[str, ParamSpec] = field(default_factory=dict)

    def __getattr__(self, name: str) -> Any:
        specs = self.__dict__.get("specs", {})
        if name in specs:
            return specs[name].value
        raise AttributeError(f"No parameter named {name!r} in params.toml (have: {', '.join(specs) or 'none'})")

    def __getitem__(self, name: str) -> Any:
        try:
            return self.specs[name].value
        except KeyError:
            raise KeyError(f"No parameter named {name!r} in params.toml") from None

    def __contains__(self, name: object) -> bool:
        return name in self.specs

    def __iter__(self) -> Iterator[str]:
        return iter(self.specs)

    def get(self, name: str, default: Any = None) -> Any:
        return self.specs[name].value if name in self.specs else default

    def values(self) -> dict[str, Any]:
        return {k: s.value for k, s in self.specs.items()}

    def out_of_range(self) -> list[str]:
        """Human-readable messages for values outside their min/max."""
        msgs = []
        for s in self.specs.values():
            if isinstance(s.value, (int, float)) and not isinstance(s.value, bool):
                if s.min is not None and s.value < s.min:
                    msgs.append(f"Parameter {s.name} = {s.value} is below its minimum {s.min}")
                if s.max is not None and s.value > s.max:
                    msgs.append(f"Parameter {s.name} = {s.value} is above its maximum {s.max}")
        return msgs


def load_params(path: str | Path = "params.toml") -> Params:
    path = Path(path)
    if path.is_dir():
        path = path / "params.toml"
    if not path.exists():
        return Params()
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise ParamError(f"{path.name}: {e}") from None

    specs: dict[str, ParamSpec] = {}
    for name, entry in data.items():
        if isinstance(entry, dict):
            if "value" not in entry:
                raise ParamError(f"{path.name}: [{name}] has no 'value'")
            unknown = set(entry) - META_KEYS
            if unknown:
                raise ParamError(f"{path.name}: [{name}] has unknown keys: {', '.join(sorted(unknown))}")
            specs[name] = ParamSpec(name=name, **entry)
        else:
            specs[name] = ParamSpec(name=name, value=entry)
    return Params(specs)


# ---------------------------------------------------------------------------- writing

_TABLE_RE = re.compile(r"^\s*\[\s*([A-Za-z0-9_\-]+|\"[^\"]*\")\s*\]\s*(#.*)?$")
_KEY_RE = re.compile(r"^(\s*)([A-Za-z0-9_\-]+|\"[^\"]*\")(\s*=\s*)(.*)$")


def coerce_value(spec: ParamSpec, raw: Any) -> Any:
    """Convert a new value (from the CLI or GUI) to the type the parameter already has."""
    old = spec.value
    if isinstance(old, bool):
        if isinstance(raw, bool):
            return raw
        s = str(raw).strip().lower()
        if s in ("true", "on", "yes", "1"):
            return True
        if s in ("false", "off", "no", "0"):
            return False
        raise ParamError(f"{spec.name} is on/off; got {raw!r}")
    if isinstance(old, (int, float)):
        if isinstance(raw, bool):
            raise ParamError(f"{spec.name} is a number; got {raw!r}")
        try:
            num = float(raw) if not isinstance(raw, (int, float)) else raw
        except ValueError:
            raise ParamError(f"{spec.name} is a number; got {raw!r}") from None
        if num != num or num in (float("inf"), float("-inf")):
            raise ParamError(f"{spec.name} must be a finite number")
        if isinstance(old, int) and float(num).is_integer():
            return int(num)
        return float(num)
    return str(raw)


def _format_toml(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.1f}" if value.is_integer() else repr(value)
    return json.dumps(value, ensure_ascii=False)


def _split_comment(rest: str) -> tuple[str, str]:
    """Split 'value   # comment' into ('value', '   # comment'), respecting quoted strings."""
    quote = None
    i = 0
    while i < len(rest):
        c = rest[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 1
            elif c == quote:
                quote = None
        elif c in ("'", '"'):
            quote = c
        elif c == "#":
            j = i
            while j > 0 and rest[j - 1] in " \t":
                j -= 1
            return rest[:j], rest[j:]
        i += 1
    stripped = rest.rstrip()
    return stripped, rest[len(stripped):]


def _unquote(key: str) -> str:
    return key[1:-1] if key.startswith('"') else key


def set_params(path: str | Path, values: dict[str, Any]) -> dict[str, Any]:
    """Change parameter values in params.toml, keeping comments, order and formatting.

    Only existing parameters can be set; adding a parameter is a code change made by editing
    the file. Returns {"changed": {name: new_value}, "warnings": [...]}.
    """
    path = Path(path)
    if path.is_dir():
        path = path / "params.toml"
    params = load_params(path)
    if not path.exists():
        raise ParamError("This project has no params.toml")
    new: dict[str, Any] = {}
    for name, raw in values.items():
        if name not in params.specs:
            raise ParamError(f"No parameter named {name!r} in params.toml (have: {', '.join(params.specs) or 'none'})")
        new[name] = coerce_value(params.specs[name], raw)

    with open(path, encoding="utf-8", newline="") as f:  # keep CRLF files CRLF
        text = f.read()
    lines = text.splitlines(keepends=True)
    table: str | None = None
    done: set[str] = set()
    for i, line in enumerate(lines):
        body = line.rstrip("\r\n")
        eol = line[len(body):]
        m = _TABLE_RE.match(body)
        if m:
            table = _unquote(m.group(1))
            continue
        m = _KEY_RE.match(body)
        if not m:
            continue
        key = _unquote(m.group(2))
        target = table if (table is not None and key == "value") else (key if table is None else None)
        if target in new and target not in done:
            _, comment = _split_comment(m.group(4))
            lines[i] = f"{m.group(1)}{m.group(2)}{m.group(3)}{_format_toml(new[target])}{comment}{eol}"
            done.add(target)
    missing = set(new) - done
    if missing:
        raise ParamError(f"Could not find where to write {', '.join(sorted(missing))} in params.toml")

    out = "".join(lines)
    check = tomllib.loads(out)  # never write a file that no longer parses
    for name, value in new.items():
        got = check[name]["value"] if isinstance(check.get(name), dict) else check.get(name)
        if got != value:
            raise ParamError(f"Internal error writing {name}: wrote {got!r}, expected {value!r}")

    tmp = path.with_name(path.name + ".tmp")  # write-then-rename so watchers never see half a file
    tmp.write_text(out, encoding="utf-8", newline="")
    os.replace(tmp, path)

    updated = load_params(path)
    warnings = [w for w in updated.out_of_range() if any(f"Parameter {n} " in w for n in new)]
    return {"changed": new, "warnings": warnings}
