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
