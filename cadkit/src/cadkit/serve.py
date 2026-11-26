"""`cadkit serve`: a long-lived worker for the desktop app.

Importing build123d takes seconds, far too slow to pay on every rebuild. The app starts one
`cadkit serve` process, which imports build123d once and then answers requests:

    stdin:  {"id": 1, "op": "build", "project": "/path/to/project", "quality": "coarse"}
    stdout: {"id": 1, "result": { ...same JSON as `cadkit build --json`... }}

The first stdout line is {"ready": true, "cadkit": "...", "build123d": "..."}.
Requests are handled one at a time. The caller enforces timeouts by killing the process.
Anything the model prints is captured into the result's "log"; stray C-level output goes to stderr,
so stdout carries only protocol lines.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import time
import traceback


def main() -> int:
    # Keep a private handle on the real stdout for protocol lines, then point fd 1 at stderr
    # so output from C libraries (OpenCASCADE) can't corrupt the protocol.
    proto = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

    from . import __version__
    from .worker import execute

    t0 = time.perf_counter()
    import build123d

    _send(proto, {"ready": True, "cadkit": __version__, "build123d": build123d.__version__,
                  "startup_ms": round((time.perf_counter() - t0) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            if req.get("op") == "shutdown":
                _send(proto, {"id": req_id, "result": {"ok": True}})
                break
            log = io.StringIO()
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                result = execute(req)
            result["log"] = "\n".join(l for l in log.getvalue().splitlines() if "cannot open font" not in l)
            _send(proto, {"id": req_id, "result": result})
        except Exception as e:  # noqa: BLE001 - never die on a bad request
            _send(proto, {"id": req_id, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()})
    return 0


def _send(proto, obj) -> None:
    proto.write(json.dumps(obj) + "\n")
    proto.flush()
