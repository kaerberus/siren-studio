"""Install the Graph Engineer into the global OpenCode config.

Shared by `install-agent.py` (the CLI) and `start.py --install`, so the two
cannot drift. Symlinks by default, so edits in this repo take effect at once
(OpenCode watches its config directories); `copy=True` makes real copies.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from install_paths import (
    GLOBAL_CONFIG, PERMISSIONS_SNIPPET, DENY_GRAPH_TOOLS, ITEMS,
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


def install(copy: bool = False) -> int:
    for source, target in ITEMS:
        if not source.exists():
            print(f"missing source: {source}", file=sys.stderr)
            return 1
        print(link_or_copy(source, target, copy))
    install_permissions()
    print()
    print("Graph Engineer installed. It appears after OpenCode restarts — the")
    print("agent and tool lists are read at startup. Verify with:")
    print("  opencode debug agents | grep graph-engineer")
    return 0


def uninstall() -> int:
    for _source, target in ITEMS:
        if target.is_symlink() or target.exists():
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()
            print(f"removed {target}")
    return 0