"""`cadkit new`: create a project folder from a template."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from .project import DEFAULT_PROFILE, ProjectError, load_profile
from .resources import data_dir

SHARED = "_shared"


class TemplateError(ValueError):
    pass


def list_templates() -> list[str]:
    return sorted(p.name for p in data_dir("templates").iterdir() if p.is_dir() and not p.name.startswith("_"))


def create_project(dest: Path, template: str, profile: str | None = None) -> Path:
    src = data_dir("templates") / template
    if template.startswith("_") or not src.is_dir():
        raise TemplateError(f"Unknown template '{template}'. Available: {', '.join(list_templates())}")
    dest = dest.resolve()
    if dest.exists() and any(dest.iterdir()):
        raise TemplateError(f"{dest} already exists and is not empty")
    profile = profile or DEFAULT_PROFILE
    try:
        prof = load_profile(profile)
    except ProjectError as e:
        raise TemplateError(str(e)) from None

    shutil.copytree(src, dest, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", ".cad"))
    values = {"project_name": dest.name, "profile": prof.id, "profile_name": prof.name}

    # project.toml from the template, with name and profile filled in
    _render_in_place(dest / "project.toml", values)

    # CLAUDE.md and AGENTS.md are generated from one shared rules file
    rules = (data_dir("templates") / SHARED / "agent-rules.md").read_text(encoding="utf-8")
    for fname, agent in (("CLAUDE.md", "Claude Code"), ("AGENTS.md", "coding agents")):
        (dest / fname).write_text(_render(rules, {**values, "agent": agent}), encoding="utf-8")
    shutil.copy(data_dir("templates") / SHARED / "gitignore", dest / ".gitignore")
    return dest


def _render(text: str, values: dict[str, str]) -> str:
    return re.sub(r"\{\{\s*(\w+)\s*\}\}", lambda m: values.get(m.group(1), m.group(0)), text)


def _render_in_place(path: Path, values: dict[str, str]) -> None:
    if path.is_file():
        path.write_text(_render(path.read_text(encoding="utf-8"), values), encoding="utf-8")
