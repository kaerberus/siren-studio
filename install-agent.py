#!/usr/bin/env python3
"""Install the Graph Engineer agent and skill into the global OpenCode config.

By default this creates symlinks so edits in this repo take effect immediately
(OpenCode watches its config directories). Use --copy for real copies.

    python3 install-agent.py
    python3 install-agent.py --copy
    python3 install-agent.py --uninstall

`python3 start.py --install` runs the same install; the logic lives in
bridge/agent_install.py so the two can't drift.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "bridge"))
from agent_install import install, uninstall  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--copy", action="store_true",
                        help="copy files instead of symlinking")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    return uninstall() if args.uninstall else install(args.copy)


if __name__ == "__main__":
    raise SystemExit(main())