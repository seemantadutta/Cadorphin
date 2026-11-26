"""Child process that runs the user's model.py.

The CLI starts `python -m cadkit.worker <request.json> <result.json>` with a timeout, so a
script that hangs or crashes never takes the CLI (or the desktop app) down with it.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from .body import Body, coerce_bodies
from .checks import Problem, fast_checks
from .params import ParamError, load_params
from .project import Project, ProjectError, load_project

EXIT_OK, EXIT_PROBLEMS, EXIT_SCRIPT_ERROR, EXIT_TIMEOUT = 0, 1, 2, 3


class ScriptError(Exception):
    pass


def _rel(project: Project, p: Path) -> str:
    try:
        return p.relative_to(project.root).as_posix()
    except ValueError:
        return str(p)


def _format_script_traceback(exc: BaseException, project_root: Path) -> str:
    """Traceback limited to frames in the user's project, so the agent sees its own code."""
    frames = traceback.extract_tb(exc.__traceback__)
    mine = [f for f in frames if Path(f.filename).resolve().is_relative_to(project_root)]
    lines = ["Traceback (most recent call last):\n"]
    lines += traceback.format_list(mine or frames[-3:])
    lines += traceback.format_exception_only(type(exc), exc)
    return "".join(lines).rstrip()


def _forget_project_modules(root: Path) -> None:
    sys.modules.pop("model", None)
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if f:
            try:
                if Path(f).resolve().is_relative_to(root):
                    del sys.modules[name]
            except (OSError, ValueError):
                pass
    importlib.invalidate_caches()


def run_model(project: Project) -> dict[str, Body]:
    try:
        params = load_params(project.root / "params.toml")
    except ParamError as e:
        raise ScriptError(str(e)) from None

    _forget_project_modules(project.root)  # a long-lived worker (cadkit serve) must see fresh edits
    sys.path.insert(0, str(project.root))  # so model.py can import boards/ and helpers
    try:
        spec = importlib.util.spec_from_file_location("model", project.model_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules["model"] = module
        spec.loader.exec_module(module)
        build = getattr(module, "build", None)
        if not callable(build):
            raise ScriptError("model.py must define a function build(params) that returns a dict of bodies")
        result = build(params)
        bodies = coerce_bodies(result)
    except ScriptError:
        raise
    except Exception as e:  # noqa: BLE001 - user code can raise anything
        raise ScriptError(_format_script_traceback(e, project.root)) from None
    finally:
        sys.path.remove(str(project.root))

    for body in bodies.values():
        if body.material is None:
            body.material = project.default_material
    run_model.params = params  # stash for range warnings
    return bodies


def body_info(name: str, body: Body, valid: bool) -> dict[str, Any]:
    bb = body.shape.bounding_box()
    return {
        "name": name,
        "material": body.material,
        "color": body.color,
        "bbox": [round(bb.size.X, 3), round(bb.size.Y, 3), round(bb.size.Z, 3)],
        "bbox_min": [round(bb.min.X, 3), round(bb.min.Y, 3), round(bb.min.Z, 3)],
        "volume_mm3": round(body.shape.volume, 3),
        "valid": valid,
    }


def param_warnings() -> list[Problem]:
    params = getattr(run_model, "params", None)
    return [Problem("warning", "param_range", m) for m in (params.out_of_range() if params else [])]


def op_build(project: Project, bodies: dict[str, Body], req: dict[str, Any], res: dict[str, Any]) -> None:
    from .checks import solid_problems
    from .exporters import write_glb

    out = project.cad_dir / "out"
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.glb"):
        if stale.stem not in bodies:
            stale.unlink()
    infos = []
    for name, body in bodies.items():
        problems = solid_problems(name, body)
        res["problems"] += [p.to_json() for p in problems]
        info = body_info(name, body, valid=not problems)
        glb = out / f"{name}.glb"
        if not problems:
            write_glb(name, body, glb, req.get("quality", "coarse"))
            info["glb"] = _rel(project, glb)
        infos.append(info)
    res["bodies"] = infos
    res["problems"] += [p.to_json() for p in param_warnings()]


def op_check(project: Project, bodies: dict[str, Body], req: dict[str, Any], res: dict[str, Any]) -> None:
    problems = fast_checks(bodies, project.profile) + param_warnings()
    bad = {p.body for p in problems if p.code in ("not_solid", "invalid_solid", "open_shell")}
    res["bodies"] = [body_info(n, b, valid=n not in bad) for n, b in bodies.items()]
    res["problems"] += [p.to_json() for p in problems]
    if not bodies:
        res["notes"].append("No bodies yet: build(params) returned an empty dict.")
    if req.get("level") == "full":
        res["notes"].append("Full checks (thin walls, small features, renders) are not implemented yet; ran fast checks only.")


def op_export(project: Project, bodies: dict[str, Body], req: dict[str, Any], res: dict[str, Any]) -> None:
    from .exporters import write_3mf, write_step, write_stl

    op_check(project, bodies, {"level": "fast"}, res)
    if not bodies:
        res["notes"].clear()
        res["problems"].append(Problem("error", "no_bodies", "Nothing to export: build(params) returned no bodies").to_json())
        return
    if any(p["severity"] == "error" for p in res["problems"]) and not req.get("force"):
        res["notes"].append("Export skipped because of errors. Fix them, or pass --force to export anyway.")
        return
    out = Path(req["out"]) if req.get("out") else project.cad_dir / "export"
    if not out.is_absolute():
        out = Path(req.get("cwd", project.root)) / out
    fmt = req["format"]
    files: list[Path] = []
    if fmt == "step":
        files.append(out / f"{project.name}.step")
        write_step(bodies, files[-1])
    elif fmt == "stl":
        for name, body in bodies.items():
            files.append(out / f"{project.name}-{name}.stl")
            write_stl(name, body, files[-1])
    elif fmt == "3mf":
        files.append(out / f"{project.name}.3mf")
        write_3mf(bodies, files[-1])
    else:
        raise ValueError(f"Unknown export format {fmt!r}")
    res["files"] = [_rel(project, f) for f in files]


OPS = {"build": op_build, "check": op_check, "export": op_export}


PROJECT_FILE_GLOBS = ("*.py", "*.toml", "*.md", "boards/**/*")


def project_info(project: Project) -> dict[str, Any]:
    """What the app needs to show a project: name, profile, parameters, files."""
    from .params import load_params

    files = sorted(
        {p.relative_to(project.root).as_posix() for g in PROJECT_FILE_GLOBS for p in project.root.glob(g) if p.is_file()}
    )
    try:
        params = [s.to_json() for s in load_params(project.root / "params.toml").specs.values()]
        params_error = None
    except ParamError as e:
        params, params_error = [], str(e)
    prof = project.profile
    return {
        "root": str(project.root),
        "name": project.name,
        "units": project.units,
        "profile": prof.summary(),
        "params": params,
        "params_error": params_error,
        "files": files,
    }


def execute(req: dict[str, Any]) -> dict[str, Any]:
    if req["op"] == "profiles":
        from .project import list_profiles, load_profile

        root = req.get("project")
        profiles = [load_profile(p).summary() for p in list_profiles()]
        if root:  # project-local profiles show up too, and win over bundled ones with the same id
            local = Path(root) / "profiles"
            ids = {p.stem for p in local.glob("*.json")} if local.is_dir() else set()
            try:
                extra = [load_profile(i, Path(root)).summary() for i in sorted(ids)]
            except ProjectError as e:
                return {"ok": False, "op": "profiles", "exit_code": EXIT_SCRIPT_ERROR, "errors": [str(e)]}
            profiles = [p for p in profiles if p["id"] not in ids] + extra
        return {"ok": True, "op": "profiles", "exit_code": EXIT_OK, "errors": [], "profiles": profiles}
    if req["op"] == "templates":
        from .templates import template_summaries

        return {"ok": True, "op": "templates", "exit_code": EXIT_OK, "errors": [], "templates": template_summaries()}
    if req["op"] == "new":
        from .templates import TemplateError, create_project

        try:
            path = create_project(Path(req["dir"]), req.get("template") or "enclosure", req.get("profile"), req.get("description"))
            return {"ok": True, "op": "new", "exit_code": EXIT_OK, "errors": [], "path": str(path)}
        except (TemplateError, OSError) as e:
            return {"ok": False, "op": "new", "exit_code": EXIT_SCRIPT_ERROR, "errors": [str(e)]}
    if req["op"] == "set_profile":
        from .project import set_profile

        try:
            prof = set_profile(req["project"], str(req.get("profile", "")))
            return {"ok": True, "op": "set_profile", "exit_code": EXIT_OK, "errors": [], "profile": prof.summary()}
        except ProjectError as e:
            return {"ok": False, "op": "set_profile", "exit_code": EXIT_SCRIPT_ERROR, "errors": [str(e)]}
    if req["op"] == "set_params":
        from .params import set_params

        try:
            project = load_project(req["project"])
            out = set_params(project.root / "params.toml", req.get("values", {}))
            return {"ok": True, "op": "set_params", "exit_code": EXIT_OK, "errors": [], **out}
        except (ProjectError, ParamError) as e:
            return {"ok": False, "op": "set_params", "exit_code": EXIT_SCRIPT_ERROR, "errors": [str(e)]}
    if req["op"] == "info":
        try:
            info = project_info(load_project(req["project"]))
            return {"ok": True, "op": "info", "exit_code": EXIT_OK, **info}
        except ProjectError as e:
            return {"ok": False, "op": "info", "exit_code": EXIT_SCRIPT_ERROR, "errors": [str(e)]}
    t0 = time.perf_counter()
    res: dict[str, Any] = {"ok": False, "op": req["op"], "bodies": [], "problems": [], "errors": [], "notes": [], "files": []}
    try:
        project = load_project(req["project"])
    except ProjectError as e:
        res["errors"].append(str(e))
        res["exit_code"] = EXIT_SCRIPT_ERROR
        res["duration_ms"] = round((time.perf_counter() - t0) * 1000)
        return res
    res["project"] = str(project.root)
    res["profile"] = project.profile.id

    t_script = time.perf_counter()
    try:
        bodies = run_model(project)
    except ScriptError as e:
        res["errors"].append(str(e))
        res["problems"].append(Problem("error", "script_error", str(e).splitlines()[-1]).to_json())
        res["exit_code"] = EXIT_SCRIPT_ERROR
    else:
        res["script_ms"] = round((time.perf_counter() - t_script) * 1000)
        try:
            OPS[req["op"]](project, bodies, req, res)
        except Exception as e:  # noqa: BLE001
            res["errors"].append(f"{type(e).__name__}: {e}")
            res["exit_code"] = EXIT_SCRIPT_ERROR
        else:
            has_errors = any(p["severity"] == "error" for p in res["problems"])
            res["exit_code"] = EXIT_PROBLEMS if has_errors else EXIT_OK
    res["ok"] = res["exit_code"] == EXIT_OK
    res["duration_ms"] = round((time.perf_counter() - t0) * 1000)

    if req["op"] == "build":
        write_manifest(project, res)
    return res


def write_manifest(project: Project, res: dict[str, Any]) -> None:
    manifest = {k: res[k] for k in ("ok", "duration_ms", "bodies", "problems", "errors")}
    manifest["profile"] = res.get("profile")
    project.cad_dir.mkdir(parents=True, exist_ok=True)
    (project.cad_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    res["manifest"] = ".cad/manifest.json"


def main(argv: list[str]) -> int:
    req_path, res_path = Path(argv[0]), Path(argv[1])
    req = json.loads(req_path.read_text(encoding="utf-8"))
    res = execute(req)
    res_path.write_text(json.dumps(res), encoding="utf-8")
    return res["exit_code"]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
