#!/usr/bin/env python3
"""Install the Graph Engineer agent and skill into the global OpenCode config.

By default this creates symlinks so edits in this repo take effect immediately
(OpenCode watches its config directories). Use --copy for real copies.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

# Target paths live in bridge/install_paths.py so doctor.py checks the same ones.
sys.path.insert(0, str(Path(__file__).resolve().parent / "bridge"))
from install_paths import (  # noqa: E402
    CONFIG, GLOBAL_CONFIG, PERMISSIONS_SNIPPET, DENY_GRAPH_TOOLS, ITEMS,
)


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


def install_permissions() -> None:
    """Deny the graph_* tools to every agent by default.

    The graph agents re-allow them in their own frontmatter; agent rules are
    appended after global rules, so the later allow wins.
    """
    if not GLOBAL_CONFIG.exists():
        shutil.copyfile(PERMISSIONS_SNIPPET, GLOBAL_CONFIG)
        print(f"created  {GLOBAL_CONFIG} (denies graph_* to every agent)")
        return
    try:
        data = json.loads(GLOBAL_CONFIG.read_text())
    except ValueError:
        data = None
    if isinstance(data, dict) and DENY_GRAPH_TOOLS in (data.get("permissions") or []):
        print(f"ok       {GLOBAL_CONFIG} already denies graph_*")
        return
    print(f"!  {GLOBAL_CONFIG} exists — merge this rule into its `permissions` array:")
    print("   " + json.dumps(DENY_GRAPH_TOOLS))


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

    install_permissions()

    print()
    print("Graph Engineer installed. Verify with:")
    print("  opencode debug agents | grep graph-engineer")
    print("  opencode debug skill 2>/dev/null | grep graph-engineering || true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
