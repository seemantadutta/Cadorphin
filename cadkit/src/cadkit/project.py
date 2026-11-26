from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .resources import data_dir
from .tomlcompat import tomllib

DEFAULT_PROFILE = "generic-256"
PROFILE_REQUIRED = {"id": str, "name": str, "build_volume_mm": list, "plate_mm": list, "nozzle_diameters_mm": list}


class ProjectError(ValueError):
    pass


@dataclass
class Profile:
    id: str
    name: str
    build_volume_mm: tuple[float, float, float]
    plate_mm: tuple[float, float]
    nozzle_diameters_mm: list[float]
    defaults: dict[str, Any] = field(default_factory=dict)
    notes: str | None = None
    vendor: str | None = None

    def summary(self) -> dict[str, Any]:
        """The fields the app shows in its printer list and status bar."""
        return {"id": self.id, "name": self.name, "vendor": self.vendor,
                "build_volume_mm": list(self.build_volume_mm), "plate_mm": list(self.plate_mm)}

    @classmethod
    def from_json(cls, data: dict[str, Any], source: str) -> "Profile":
        for key, typ in PROFILE_REQUIRED.items():
            if not isinstance(data.get(key), typ):
                raise ProjectError(f"Profile {source}: missing or invalid '{key}'")
        if len(data["build_volume_mm"]) != 3 or len(data["plate_mm"]) != 2:
            raise ProjectError(f"Profile {source}: build_volume_mm needs 3 numbers and plate_mm needs 2")
        return cls(
            id=data["id"],
            name=data["name"],
            build_volume_mm=tuple(float(v) for v in data["build_volume_mm"]),
            plate_mm=tuple(float(v) for v in data["plate_mm"]),
            nozzle_diameters_mm=[float(v) for v in data["nozzle_diameters_mm"]],
            defaults=data.get("defaults", {}),
            notes=data.get("notes"),
            vendor=data.get("vendor"),
        )


def load_profile(profile_id: str, project_dir: Path | None = None) -> Profile:
    """Project-local profiles/<id>.json wins over the bundled profiles."""
    candidates = []
    if project_dir is not None:
        candidates.append(project_dir / "profiles" / f"{profile_id}.json")
    candidates.append(data_dir("profiles") / f"{profile_id}.json")
    for path in candidates:
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                raise ProjectError(f"Profile {path}: {e}") from None
            return Profile.from_json(data, str(path))
    raise ProjectError(f"Unknown printer profile '{profile_id}'. Available: {', '.join(list_profiles())}")


def list_profiles() -> list[str]:
    return sorted(p.stem for p in data_dir("profiles").glob("*.json") if p.stem != "schema")


@dataclass
class Project:
    root: Path
    name: str
    profile: Profile
    units: str = "mm"
    default_material: str | None = None

    @property
    def model_path(self) -> Path:
        return self.root / "model.py"

    @property
    def cad_dir(self) -> Path:
        return self.root / ".cad"


def load_project(path: str | Path = ".") -> Project:
    root = Path(path).resolve()
    if root.is_file():
        root = root.parent
    if not (root / "model.py").is_file():
        raise ProjectError(f"No model.py in {root}. Is this a cadkit project? Create one with 'cadkit new <dir>'.")
    cfg: dict[str, Any] = {}
    cfg_path = root / "project.toml"
    if cfg_path.is_file():
        try:
            cfg = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as e:
            raise ProjectError(f"project.toml: {e}") from None
    units = cfg.get("units", "mm")
    if units != "mm":
        raise ProjectError(f"project.toml: units = {units!r} is not supported (only 'mm')")
    return Project(
        root=root,
        name=cfg.get("name", root.name),
        profile=load_profile(cfg.get("profile", DEFAULT_PROFILE), root),
        units=units,
        default_material=cfg.get("materials", {}).get("default"),
    )


_TOP_PROFILE_RE = re.compile(r"""^(\s*profile\s*=\s*)("[^"]*"|'[^']*')(.*)$""")
_TABLE_LINE_RE = re.compile(r"^\s*\[")


def set_profile(path: str | Path, profile_id: str) -> Profile:
    """Point a project at another printer profile by rewriting `profile = "..."` in project.toml.

    Everything else in the file (comments, order, line endings) is kept. If the file has no
    top-level `profile` key, one is added before the first table. Returns the new profile.
    """
    root = Path(path).resolve()
    if not (root / "model.py").is_file():
        raise ProjectError(f"No model.py in {root}. Is this a cadkit project?")
    prof = load_profile(profile_id, root)  # refuse unknown ids before touching the file
    cfg_path = root / "project.toml"
    text = ""
    if cfg_path.is_file():
        with open(cfg_path, encoding="utf-8", newline="") as f:  # keep CRLF files CRLF
            text = f.read()
    eol = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines(keepends=True)
    first_table = next((i for i, l in enumerate(lines) if _TABLE_LINE_RE.match(l)), len(lines))
    for i in range(first_table):
        body = lines[i].rstrip("\r\n")
        m = _TOP_PROFILE_RE.match(body)
        if m:
            lines[i] = f'{m.group(1)}"{prof.id}"{m.group(3)}{lines[i][len(body):]}'
            break
    else:
        at = first_table
        while at > 0 and not lines[at - 1].strip():  # insert above the blank lines before a table
            at -= 1
        if at > 0 and not lines[at - 1].endswith("\n"):
            lines[at - 1] += eol
        lines.insert(at, f'profile = "{prof.id}"{eol}')
    out = "".join(lines)
    try:
        cfg = tomllib.loads(out)  # never write a file that no longer parses
    except tomllib.TOMLDecodeError as e:
        raise ProjectError(f"project.toml: could not update the profile ({e})") from None
    if cfg.get("profile") != prof.id:
        raise ProjectError("project.toml: could not update the profile")
    tmp = cfg_path.with_name(cfg_path.name + ".tmp")  # write-then-rename so watchers never see half a file
    tmp.write_text(out, encoding="utf-8", newline="")
    os.replace(tmp, cfg_path)
    return prof
