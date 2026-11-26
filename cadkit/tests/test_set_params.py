"""`cadkit set` / set_params: edit values in params.toml without disturbing the rest of the file."""

from __future__ import annotations

import pytest

from cadkit.params import ParamError, load_params, set_params

ORIGINAL = """\
# Enclosure parameters. Comments must survive edits.

name = "box"   # display name
count = 4
flag = true

[wall]
value = 2.2      # mm, tweak for your printer
unit = "mm"
min = 1.2
max = 5
label = "Wall # thickness"

[length]
label = "Length"
value = 72.0
"""


@pytest.fixture
def params_file(tmp_path):
    p = tmp_path / "params.toml"
    p.write_text(ORIGINAL, encoding="utf-8")
    return p


def test_set_keeps_comments_order_and_other_values(params_file):
    out = set_params(params_file, {"wall": "2.6", "length": 90, "count": "6", "flag": "off", "name": 'my "box"'})
    assert out["changed"] == {"wall": 2.6, "length": 90.0, "count": 6, "flag": False, "name": 'my "box"'}
    assert out["warnings"] == []
    text = params_file.read_text(encoding="utf-8")
    assert text == ORIGINAL.replace("value = 2.2      # mm", "value = 2.6      # mm").replace(
        "value = 72.0", "value = 90.0"
    ).replace("count = 4", "count = 6").replace("flag = true", "flag = false").replace(
        'name = "box"   #', 'name = "my \\"box\\""   #'
    )
    p = load_params(params_file)
    assert p.wall == 2.6 and p.length == 90.0 and p.count == 6 and p.flag is False and p.name == 'my "box"'
    assert p.specs["wall"].label == "Wall # thickness"  # '#' inside a string is not a comment


def test_float_stays_float_and_int_stays_int(params_file):
    set_params(params_file, {"length": "100", "count": "7"})
    p = load_params(params_file)
    assert isinstance(p.length, float) and p.length == 100.0
    assert isinstance(p.count, int) and p.count == 7
    set_params(params_file, {"count": "7.5"})
    assert load_params(params_file).count == 7.5


def test_out_of_range_is_written_with_a_warning(params_file):
    out = set_params(params_file, {"wall": 9})
    assert load_params(params_file).wall == 9.0
    assert out["warnings"] == ["Parameter wall = 9.0 is above its maximum 5"]


@pytest.mark.parametrize(
    "values, match",
    [
        ({"nope": 1}, "No parameter named 'nope'"),
        ({"wall": "thick"}, "wall is a number"),
        ({"flag": "maybe"}, "flag is on/off"),
        ({"wall": "nan"}, "finite"),
    ],
)
def test_bad_values_leave_the_file_untouched(params_file, values, match):
    with pytest.raises(ParamError, match=match):
        set_params(params_file, values)
    assert params_file.read_text(encoding="utf-8") == ORIGINAL


def test_crlf_line_endings_are_kept(tmp_path):
    p = tmp_path / "params.toml"
    p.write_bytes(b"[wall]\r\nvalue = 2.2\r\nunit = \"mm\"\r\n")
    set_params(p, {"wall": 3})
    assert p.read_bytes() == b"[wall]\r\nvalue = 3.0\r\nunit = \"mm\"\r\n"


def test_cli_set(make_project, cli):
    root = make_project("def build(p):\n    pass\n", params="[wall]\nvalue = 2.2\nmax = 5\n")
    code, res = cli("set", "wall=3.5", "--path", str(root))
    assert code == 0, res
    assert res["changed"] == {"wall": 3.5}
    assert load_params(root).wall == 3.5

    code, res = cli("set", "wall=abc", "--path", str(root))
    assert code == 2 and "wall is a number" in res["errors"][0]
