#!/usr/bin/env python3
"""Mermaid Studio launcher.

Starts the local bridge (which serves the editor and proxies OpenCode) and
opens it in your browser.

    python3 start.py
    python3 start.py --project ~/code/my-project
    python3 start.py --checkout          # force this repo, ignoring the last one
    python3 start.py --workspace ~/code/my-project --port 8777 --no-browser

With no `--project`, the editor reopens the last project you used, and falls back
to this checkout the first time.
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "bridge"))

try:
    import server  # type: ignore  # noqa: E402  (bridge/server.py)
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(f"cannot import bridge server: {exc}\n")
    raise SystemExit(1)

if __name__ == "__main__":
    if sys.version_info < (3, 9):
        sys.stderr.write("Python 3.9 or newer is required.\n")
        raise SystemExit(1)
    raise SystemExit(server.main())
