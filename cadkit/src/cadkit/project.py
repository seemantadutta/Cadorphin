from __future__ import annotations

import json
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
