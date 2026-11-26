from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

_HEX = re.compile(r"^#(?:[0-9a-fA-F]{6})$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]*$")
DEFAULT_COLOR = "#B8BCC4"


@dataclass
class Body:
    """One separately printed part: a build123d shape plus print metadata."""

    shape: Any
    material: str | None = None
    color: str | None = None

    def __post_init__(self) -> None:
        if self.color is not None and not _HEX.match(self.color):
            raise ValueError(f"Body color must look like '#RRGGBB', got {self.color!r}")


def coerce_bodies(result: Any) -> dict[str, Body]:
    """Validate what build(params) returned and normalise it to dict[str, Body]."""
    if not isinstance(result, dict) or not result:
        raise TypeError(
            "build(params) must return a non-empty dict mapping body names to Body objects, "
            f"got {type(result).__name__}"
        )
    bodies: dict[str, Body] = {}
    for name, value in result.items():
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise ValueError(
                f"Body name {name!r} is not allowed: use letters, digits, '_' or '-', starting with a letter or digit"
            )
        if not isinstance(value, Body):
            if hasattr(value, "wrapped"):  # a bare build123d shape
                value = Body(value)
            else:
                raise TypeError(f"Body {name!r} must be a cadkit.Body or a build123d shape, got {type(value).__name__}")
        if not hasattr(value.shape, "wrapped"):
            raise TypeError(f"Body {name!r}: shape must be a build123d shape, got {type(value.shape).__name__}")
        bodies[name] = value
    return bodies
