# cadkit needs Python 3.11+, where tomllib is in the standard library. Kept as a module so the
# import sites stay unchanged.
import tomllib

__all__ = ["tomllib"]
