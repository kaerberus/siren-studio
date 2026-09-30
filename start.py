#!/usr/bin/env python3
"""Siren Studio launcher.

Starts the local bridge (which serves the editor and proxies OpenCode) and
opens it in your browser.

    python3 start.py
    python3 start.py --install           # install the Graph Engineer, then launch
    python3 start.py --check             # verify your setup, then exit
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

def _warn_if_agent_missing() -> None:
    try:
        from install_paths import ITEMS  # noqa: E402  (bridge/install_paths.py)
    except ImportError:
        return
    if all(target.is_symlink() or target.exists() for _source, target in ITEMS):
        return
    sys.stderr.write(
        "Graph Engineer not installed — run `python3 start.py --install` "
        "(then restart OpenCode).\n")


if __name__ == "__main__":
    if sys.version_info < (3, 9):
        sys.stderr.write("Python 3.9 or newer is required.\n")
        raise SystemExit(1)

    argv = sys.argv[1:]
    if "--install" in argv:
        import agent_install  # type: ignore  # noqa: E402  (bridge/agent_install.py)
        status = agent_install.install()
        if status:
            raise SystemExit(status)
        argv = [arg for arg in argv if arg != "--install"]
        sys.argv = [sys.argv[0]] + argv

    if "--check" in argv:
        import doctor  # type: ignore  # noqa: E402  (bridge/doctor.py)
        raise SystemExit(doctor.main(argv))

    _warn_if_agent_missing()
    raise SystemExit(server.main())
