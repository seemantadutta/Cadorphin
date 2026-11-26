"""`cadkit info` and the long-lived `cadkit serve` worker used by the desktop app."""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap

MODEL = """
from build123d import *

def build(p):
    print("building", p.size)
    return {"part": Box(p.size, p.size, p.size)}
"""


def test_info(make_project, cli):
    root = make_project(MODEL, params="[size]\nvalue = 10\nunit = 'mm'\nlabel = 'Size'\n")
    code, res = cli("info", str(root))
    assert code == 0, res
    assert res["name"] == "proj"
    assert res["profile"]["id"] == "generic-256" and res["profile"]["build_volume_mm"] == [256.0, 256.0, 256.0]
    assert res["params"] == [{"name": "size", "value": 10, "unit": "mm", "label": "Size"}]
    assert {"model.py", "params.toml", "project.toml"} <= set(res["files"])


def test_info_not_a_project(tmp_path, cli):
    code, res = cli("info", str(tmp_path))
    assert code == 2 and "No model.py" in res["errors"][0]


class Server:
    def __init__(self):
        self.p = subprocess.Popen(
            [sys.executable, "-m", "cadkit", "serve"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
        )
        self.ready = json.loads(self.p.stdout.readline())
        self.next_id = 0

    def ask(self, **req):
        self.next_id += 1
        self.p.stdin.write(json.dumps({"id": self.next_id, **req}) + "\n")
        self.p.stdin.flush()
        msg = json.loads(self.p.stdout.readline())
        assert msg["id"] == self.next_id
        return msg

    def close(self):
        self.ask(op="shutdown")
        self.p.wait(10)


def test_serve_rebuilds_with_fresh_code_and_params(make_project):
    root = make_project(MODEL, params="size = 10\n")
    s = Server()
    try:
        assert s.ready["ready"] is True and s.ready["build123d"]

        r = s.ask(op="build", project=str(root))["result"]
        assert r["ok"] and r["bodies"][0]["bbox"] == [10.0, 10.0, 10.0]
        assert r["log"] == "building 10"  # model output is captured, not mixed into the protocol
        assert (root / ".cad" / "out" / "part.glb").exists()

        (root / "params.toml").write_text("size = 20\n", encoding="utf-8")
        r = s.ask(op="build", project=str(root))["result"]
        assert r["bodies"][0]["bbox"] == [20.0, 20.0, 20.0]

        # Edited model code must be picked up, not served from the module cache.
        (root / "model.py").write_text(textwrap.dedent(MODEL).replace("p.size, p.size, p.size", "p.size, 5, 5"), encoding="utf-8")
        r = s.ask(op="check", project=str(root))["result"]
        assert r["bodies"][0]["bbox"] == [20.0, 5.0, 5.0]

        # A script error is a normal result; the server keeps going.
        (root / "model.py").write_text("def build(p):\n    raise ValueError('nope')\n", encoding="utf-8")
        r = s.ask(op="build", project=str(root))["result"]
        assert r["exit_code"] == 2 and "nope" in r["errors"][0]

        info = s.ask(op="info", project=str(root))["result"]
        assert info["ok"] and info["name"] == "proj"
    finally:
        s.close()
    assert s.p.returncode == 0


def test_serve_survives_bad_requests(make_project):
    s = Server()
    try:
        s.p.stdin.write("this is not json\n")
        s.p.stdin.flush()
        msg = json.loads(s.p.stdout.readline())
        assert "error" in msg
        r = s.ask(op="build", project=str(make_project(MODEL, params="size = 3\n")))["result"]
        assert r["ok"]
    finally:
        s.close()
