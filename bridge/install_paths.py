"""Where the Graph Engineer gets installed — one source of truth.

`install-agent.py` writes these and `bridge/doctor.py` verifies them, so the two
can never disagree about the target paths. Kept dependency-free on purpose.
"""
from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "opencode"
GLOBAL_CONFIG = CONFIG / "opencode.jsonc"
PERMISSIONS_SNIPPET = REPO / "agent" / "global-permissions.json"
DENY_GRAPH_TOOLS = {"action": "graph_*", "resource": "*", "effect": "deny"}

AGENT_ID = "graph-engineer"

# (source in this repo, destination in the global OpenCode config)
ITEMS = [
    (REPO / "agent" / "graph-engineer.md", CONFIG / "agents" / "graph-engineer.md"),
    (REPO / "agent" / "skills" / "graph-engineering",
     CONFIG / "skills" / "graph-engineering"),
    (REPO / "agent" / "plugins" / "graph-tools.js", CONFIG / "plugins" / "graph-tools.js"),
]
