"""`cadkit new`: create a project folder from a template."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from .project import DEFAULT_PROFILE, ProjectError, load_profile
from .resources import data_dir

SHARED = "_shared"

# Shown in the app's New Project dialog. A template without an entry still works.
TEMPLATE_DESCRIPTIONS = {
    "empty": "Nothing yet: an empty model for you or your agent to fill in.",
    "enclosure": "Two-part case with a lid, heat-set insert bosses, a USB-C cutout and a light pipe.",
    "blank": "A single parametric cube to start from.",
}


class TemplateError(ValueError):
    pass


def list_templates() -> list[str]:
    return sorted(p.name for p in data_dir("templates").iterdir() if p.is_dir() and not p.name.startswith("_"))


def template_summaries() -> list[dict[str, str]]:
    names = list_templates()
    names.sort(key=lambda n: (n not in TEMPLATE_DESCRIPTIONS, list(TEMPLATE_DESCRIPTIONS).index(n) if n in TEMPLATE_DESCRIPTIONS else 0, n))
    return [{"id": n, "description": TEMPLATE_DESCRIPTIONS.get(n, "")} for n in names]


# Instruction files written into every project, and the agent each one is for. Claude Code reads
# CLAUDE.md, Codex and most other agents read AGENTS.md, and Gemini CLI reads GEMINI.md.
AGENT_FILES = (("CLAUDE.md", "Claude Code"), ("AGENTS.md", "coding agents"), ("GEMINI.md", "Gemini CLI"))


def design_brief(description: str) -> str:
    """The user's own description of the design, appended to the generated rules (never replacing them)."""
    text = "\n".join(description.strip().splitlines())
    return (
        "\n## Design brief\n\n"
        "Written by the user when the project was created. It is what this design is for; use it to guide your choices.\n\n"
        f"{text}\n"
    )


def create_project(dest: Path, template: str, profile: str | None = None, description: str | None = None) -> Path:
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

    # The agent instruction files are generated from one shared rules file, plus the user's brief
    rules = (data_dir("templates") / SHARED / "agent-rules.md").read_text(encoding="utf-8")
    brief = design_brief(description) if description and description.strip() else ""
    for fname, agent in AGENT_FILES:
        (dest / fname).write_text(_render(rules, {**values, "agent": agent}) + brief, encoding="utf-8")
    shutil.copy(data_dir("templates") / SHARED / "gitignore", dest / ".gitignore")
    return dest


def _render(text: str, values: dict[str, str]) -> str:
    return re.sub(r"\{\{\s*(\w+)\s*\}\}", lambda m: values.get(m.group(1), m.group(0)), text)


def _render_in_place(path: Path, values: dict[str, str]) -> None:
    if path.is_file():
        path.write_text(_render(path.read_text(encoding="utf-8"), values), encoding="utf-8")
