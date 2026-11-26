"""cadkit command line: the interface shared by coding agents and the desktop app.

Exit codes: 0 ok, 1 problems found (errors), 2 script or project error, 3 timeout.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from . import __version__
from .worker import EXIT_SCRIPT_ERROR, EXIT_TIMEOUT

DEFAULT_TIMEOUT_S = float(os.environ.get("CADKIT_TIMEOUT", "30"))


# ---------------------------------------------------------------- output helpers

class Out:
    def __init__(self) -> None:
        enc = (getattr(sys.stdout, "encoding", None) or "ascii").lower()
        try:
            "✓✗⚠×³".encode(enc)
            self.ok, self.err, self.warn = "✓", "✗", "⚠"
        except (UnicodeEncodeError, LookupError):
            self.ok, self.err, self.warn = "OK", "X", "!"
        self.enc = enc

    def p(self, text: str = "") -> None:
        print(text.encode(self.enc, errors="replace").decode(self.enc, errors="replace"))


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def print_result(res: dict[str, Any], out: Out) -> None:
    if res.get("timeout"):
        out.p(f"{out.err} {res['errors'][0]}")
        return
    if "script_ms" in res:
        out.p(f"{out.ok} Script ran in {res['script_ms'] / 1000:.1f} s")
    for e in res["errors"]:
        out.p(f"{out.err} {e}" if "\n" not in e else f"{out.err} Script error:\n{e}")
    if res["bodies"]:
        n = len(res["bodies"])
        out.p(f"{out.ok} {n} {'body' if n == 1 else 'bodies'}: " + ", ".join(b["name"] for b in res["bodies"]))
    problems = [p for p in res["problems"] if p["code"] != "script_error"]
    for p in problems:
        mark = out.err if p["severity"] == "error" else out.warn
        loc = ""
        if p.get("location"):
            x, y, z = p["location"]
            loc = f" near ({x:.1f}, {y:.1f}, {z:.1f})"
        out.p(f"{mark} {p['message']}{loc}")
    if res.get("manifest"):
        out.p(f"Manifest: {res['manifest']}")
    for f in res.get("files", []):
        out.p(f"Wrote {f}")
    for n in res.get("notes", []):
        out.p(f"Note: {n}")
    if res["op"] != "build" and not res["errors"]:
        n_err = sum(p["severity"] == "error" for p in problems)
        n_warn = len(problems) - n_err
        if not problems:
            out.p("No problems found")
        else:
            parts = [_plural(n_err, "problem")] if n_err else []
            if n_warn:
                parts.append(_plural(n_warn, "warning"))
            out.p(" and ".join(parts) + " found")


# ---------------------------------------------------------------- worker runner

def run_worker(req: dict[str, Any], timeout: float) -> dict[str, Any]:
    """Run the model in a child process so a hung or crashing script can't take us down."""
    project = Path(req["project"]).resolve()
    if not (project / "model.py").is_file():
        return {
            "ok": False, "op": req["op"], "exit_code": EXIT_SCRIPT_ERROR, "bodies": [], "problems": [], "files": [], "notes": [],
            "errors": [f"No model.py in {project}. Is this a cadkit project? Create one with 'cadkit new <dir>'."],
        }
    tmp_root = project / ".cad" / "tmp"  # keep scratch files inside the project
    tmp_root.mkdir(parents=True, exist_ok=True)
    tag = uuid.uuid4().hex[:8]
    req_path, res_path = tmp_root / f"req-{tag}.json", tmp_root / f"res-{tag}.json"
    req_path.write_text(json.dumps(req), encoding="utf-8")
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "cadkit.worker", str(req_path), str(res_path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired as e:
        return {
            "ok": False, "op": req["op"], "timeout": True, "exit_code": EXIT_TIMEOUT,
            "bodies": [], "problems": [], "files": [], "notes": [],
            "errors": [f"Timed out after {timeout:g} s (model.py took too long; raise it with --timeout)"],
            "log": (e.stdout or "") if isinstance(e.stdout, str) else "",
        }
    finally:
        req_path.unlink(missing_ok=True)
    try:
        res = json.loads(res_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        res = {
            "ok": False, "op": req["op"], "exit_code": EXIT_SCRIPT_ERROR, "bodies": [], "problems": [], "files": [], "notes": [],
            "errors": ["cadkit worker crashed:\n" + (proc.stderr.strip()[-4000:] or f"exit code {proc.returncode}")],
        }
    finally:
        res_path.unlink(missing_ok=True)
    log = "\n".join(l for l in (proc.stdout + proc.stderr).splitlines() if "cannot open font" not in l)
    res["log"] = log.strip()
    return res


def _emit(res: dict[str, Any], as_json: bool) -> int:
    if as_json:
        print(json.dumps(res, indent=2))
    else:
        out = Out()
        print_result(res, out)
        if res.get("log") and res["exit_code"] == EXIT_SCRIPT_ERROR and "worker crashed" not in "".join(res["errors"]):
            out.p("--- script output ---\n" + res["log"])
    return int(res["exit_code"])


# ---------------------------------------------------------------- commands

def cmd_build(a: argparse.Namespace) -> int:
    req = {"op": "build", "project": a.path, "quality": a.quality}
    return _emit(run_worker(req, a.timeout), a.json)


def cmd_check(a: argparse.Namespace) -> int:
    req = {"op": "check", "project": a.path, "level": "full" if a.full else "fast"}
    return _emit(run_worker(req, a.timeout), a.json)


def cmd_export(a: argparse.Namespace) -> int:
    req = {"op": "export", "project": a.path, "format": a.format, "out": a.out, "force": a.force, "cwd": os.getcwd()}
    return _emit(run_worker(req, a.timeout), a.json)


def cmd_new(a: argparse.Namespace) -> int:
    from .templates import TemplateError, create_project

    try:
        path = create_project(Path(a.dir), a.template, a.profile, a.description)
    except TemplateError as e:
        if a.json:
            print(json.dumps({"ok": False, "errors": [str(e)]}))
        else:
            print(f"Error: {e}", file=sys.stderr)
        return EXIT_SCRIPT_ERROR
    if a.json:
        print(json.dumps({"ok": True, "path": str(path), "template": a.template}))
    else:
        print(f"Created {a.template} project in {path}")
        print(f"Next: cd {a.dir} && cadkit check")
    return 0


def cmd_info(a: argparse.Namespace) -> int:
    """Project summary. Runs in-process: it reads files but never runs model.py."""
    from .worker import execute

    res = execute({"op": "info", "project": a.path})
    if a.json:
        print(json.dumps(res, indent=2))
    elif not res["ok"]:
        print(f"Error: {res['errors'][0]}", file=sys.stderr)
    else:
        prof = res["profile"]
        print(f"{res['name']}  ({res['root']})")
        print(f"Profile: {prof['id']} ({prof['name']}, {' x '.join(f'{v:g}' for v in prof['build_volume_mm'])} mm)")
        print(f"Parameters: {', '.join(p['name'] for p in res['params']) or 'none'}")
        print(f"Files: {', '.join(res['files'])}")
    return int(res["exit_code"])


def cmd_set(a: argparse.Namespace) -> int:
    """Change parameter values in params.toml in place. Runs in-process; never runs model.py."""
    from .worker import execute

    values: dict[str, str] = {}
    for item in a.assignments:
        name, sep, value = item.partition("=")
        if not sep or not name.strip():
            msg = f"Expected name=value, got {item!r}"
            print(json.dumps({"ok": False, "errors": [msg]}) if a.json else f"Error: {msg}", file=None if a.json else sys.stderr)
            return EXIT_SCRIPT_ERROR
        values[name.strip()] = value.strip()
    res = execute({"op": "set_params", "project": a.path, "values": values})
    if a.json:
        print(json.dumps(res, indent=2))
    elif not res["ok"]:
        print(f"Error: {res['errors'][0]}", file=sys.stderr)
    else:
        out = Out()
        for name, value in res["changed"].items():
            out.p(f"{out.ok} {name} = {value}")
        for w in res["warnings"]:
            out.p(f"{out.warn} {w}")
    return int(res["exit_code"])


def cmd_set_profile(a: argparse.Namespace) -> int:
    """Choose the project's printer. Runs in-process; never runs model.py."""
    from .worker import execute

    res = execute({"op": "set_profile", "project": a.path, "profile": a.profile})
    if a.json:
        print(json.dumps(res, indent=2))
    elif not res["ok"]:
        print(f"Error: {res['errors'][0]}", file=sys.stderr)
    else:
        prof = res["profile"]
        x, y, z = prof["build_volume_mm"]
        out = Out()
        out.p(f"{out.ok} Printer: {prof['name']} ({x:g} x {y:g} x {z:g} mm)")
    return int(res["exit_code"])


def cmd_serve(a: argparse.Namespace) -> int:
    from .serve import main as serve_main

    return serve_main()


def cmd_profiles(a: argparse.Namespace) -> int:
    from .project import list_profiles, load_profile

    profiles = [load_profile(p) for p in list_profiles()]
    if a.json:
        print(json.dumps([p.__dict__ for p in profiles], indent=2))
    else:
        for p in profiles:
            x, y, z = p.build_volume_mm
            print(f"{p.id:16} {p.name:24} {x:g} x {y:g} x {z:g} mm")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="cadkit", description="Build, check and export parametric build123d models.")
    ap.add_argument("--version", action="version", version=f"cadkit {__version__}")
    sub = ap.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser, path: bool = True) -> None:
        if path:
            p.add_argument("path", nargs="?", default=".", help="project folder (default: current folder)")
            p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S, help="seconds before giving up (default 30)")
        p.add_argument("--json", action="store_true", help="machine-readable output")

    p = sub.add_parser("build", help="run model.py and write .cad/out/<body>.glb and .cad/manifest.json")
    common(p)
    p.add_argument("--quality", choices=["coarse", "fine"], default="coarse", help="viewer mesh quality")
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("check", help="check the model (valid solids, fits the printer, no overlaps)")
    common(p)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--fast", action="store_true", help="fast checks (default)")
    g.add_argument("--full", action="store_true", help="fast checks plus thin walls and renders")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("export", help="export STEP, STL or 3MF")
    common(p)
    p.add_argument("--format", required=True, choices=["step", "stl", "3mf"])
    p.add_argument("--out", help="output folder (default: .cad/export)")
    p.add_argument("--force", action="store_true", help="export even if checks find errors")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("new", help="create a project from a template")
    p.add_argument("dir")
    p.add_argument("--template", default="enclosure", help="enclosure or blank (default: enclosure)")
    p.add_argument("--profile", default=None, help="printer profile id (see 'cadkit profiles')")
    p.add_argument("--description", default=None, help="what the design is for; added to CLAUDE.md, AGENTS.md and GEMINI.md")
    common(p, path=False)
    p.set_defaults(func=cmd_new)

    p = sub.add_parser("profiles", help="list printer profiles")
    common(p, path=False)
    p.set_defaults(func=cmd_profiles)

    p = sub.add_parser("info", help="show project name, profile, parameters and files (does not run model.py)")
    p.add_argument("path", nargs="?", default=".", help="project folder (default: current folder)")
    common(p, path=False)
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("set", help="change parameter values in params.toml, e.g. cadkit set wall=2.4 length=90")
    p.add_argument("assignments", nargs="+", metavar="name=value")
    p.add_argument("--path", default=".", help="project folder (default: current folder)")
    common(p, path=False)
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("set-profile", help="choose the project's printer profile, e.g. cadkit set-profile bambu-p1s")
    p.add_argument("profile", metavar="ID", help="profile id (see 'cadkit profiles')")
    p.add_argument("--path", default=".", help="project folder (default: current folder)")
    common(p, path=False)
    p.set_defaults(func=cmd_set_profile)

    p = sub.add_parser("serve", help="long-lived JSON-lines worker used by the desktop app")
    p.set_defaults(func=cmd_serve)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
