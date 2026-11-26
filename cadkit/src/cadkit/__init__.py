"""cadkit: build, check and export parametric build123d models."""

from .body import Body
from .params import Params, load_params

__version__ = "0.1.0"
APP_NAME = "Cadorphin"

__all__ = ["Body", "Params", "load_params", "__version__", "APP_NAME"]
