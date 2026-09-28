#!/usr/bin/env python3
"""Install the Graph Engineer agent and skill into the global OpenCode config.

By default this creates symlinks so edits in this repo take effect immediately
(OpenCode watches its config directories). Use --copy for real copies.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "opencode"

ITEMS = [
    (REPO / "agent" / "graph-engineer.md", CONFIG / "agents" / "graph-engineer.md"),
    (REPO / "agent" / "skills" / "graph-engineering",
     CONFIG / "skills" / "graph-engineering"),
    (REPO / "agent" / "plugins" / "graph-tools.js",
     CONFIG / "plugins" / "graph-tools.js"),
]


def link_or_copy(source: Path, target: Path, copy: bool) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() or target.exists():
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    if copy:
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
        return f"copied  {target}"
    os.symlink(source, target)
    return f"linked  {target} -> {source}"


def uninstall() -> None:
    for _source, target in ITEMS:
        if target.is_symlink() or target.exists():
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()
            print(f"removed {target}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--copy", action="store_true",
                        help="copy files instead of symlinking")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()

    if args.uninstall:
        uninstall()
        return 0

    for source, target in ITEMS:
        if not source.exists():
            print(f"missing source: {source}", file=sys.stderr)
            return 1
        print(link_or_copy(source, target, args.copy))

    print()
    print("Graph Engineer installed. Verify with:")
    print("  opencode debug agents | grep graph-engineer")
    print("  opencode debug skill 2>/dev/null | grep graph-engineering || true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
