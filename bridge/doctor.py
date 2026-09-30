#!/usr/bin/env python3
"""Setup check for Siren Studio.

Verifies the pieces a fresh install needs and prints what to fix. It runs on its
own — no bridge required — so it works before you launch.

    python3 start.py --check
    python3 bridge/doctor.py            # the same check
    python3 bridge/doctor.py --json     # machine-readable
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

import server
import install_paths

REPO = install_paths.REPO
ASSETS = (
    REPO / "app" / "index.html",
    REPO / "app" / "vendor" / "mermaid.min.js",
    REPO / "app" / "vendor" / "codemirror" / "codemirror.min.js",
)

OK, FAIL, WARN, INFO = "ok", "fail", "warn", "info"


def _result(cid: str, label: str, status: str, detail: str = "",
            remedy: str = "", vital: bool = False) -> dict:
    return {"id": cid, "label": label, "status": status, "detail": detail,
            "remedy": remedy, "vital": vital}


def _health_up(port: int) -> bool:
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/health", timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def _opencode_probe(oc_url: str | None):
    """(client, agent ids or None, human detail). None ids means unreachable."""
    discovery = server.discover_service()
    if not discovery and not oc_url:
        return None, None, "no running OpenCode service found"
    oc = server.OpenCode()
    oc.configure(discovery, oc_url)
    try:
        data = oc.json("GET", "/api/agent", timeout=10)
    except Exception:
        return oc, None, f"not answering at {oc.url or 'n/a'}"
    listing = data.get("data") if isinstance(data, dict) else data
    ids = [agent.get("id") for agent in (listing or []) if isinstance(agent, dict)]
    version = (discovery or {}).get("version") or ""
    detail = f"reachable at {oc.url}" + (f" (OpenCode v{version})" if version else "")
    return oc, ids, detail


def run_checks(project: str | None = None, oc_url: str | None = None) -> list[dict]:
    results: list[dict] = []

    version = sys.version_info
    results.append(_result(
        "python", "Python 3.9+",
        OK if (version.major, version.minor) >= (3, 9) else FAIL,
        f"{version.major}.{version.minor}.{version.micro}",
        "install Python 3.9 or newer", vital=True))

    missing = [str(path.relative_to(REPO)) for path in ASSETS if not path.exists()]
    results.append(_result(
        "assets", "App assets vendored",
        OK if not missing else FAIL,
        "mermaid 11 + CodeMirror 5 present" if not missing else "missing: " + ", ".join(missing),
        "re-clone the repository", vital=True))

    _oc, agent_ids, oc_detail = _opencode_probe(oc_url)
    reachable = agent_ids is not None
    results.append(_result(
        "opencode", "OpenCode service",
        OK if reachable else WARN, oc_detail,
        "run `opencode`, then re-run this check"))

    labels = {"agent": "Graph Engineer agent", "skill": "graph-engineering skill",
              "plugin": "graph-tools plugin"}
    for key, (_source, target) in zip(("agent", "skill", "plugin"), install_paths.ITEMS):
        exists = target.is_symlink() or target.exists()
        status, detail, remedy = (OK, str(target), "") if exists else (
            FAIL, str(target), "python3 install-agent.py")
        if exists and key == "agent" and reachable and install_paths.AGENT_ID not in agent_ids:
            status, remedy = WARN, "restart OpenCode to pick up the agent"
            detail += "  (not listed by OpenCode yet)"
        results.append(_result(key, labels[key], status, detail, remedy, vital=True))

    config = install_paths.GLOBAL_CONFIG
    if not config.exists():
        perm = (WARN, f"{config} not created yet", "python3 install-agent.py")
    else:
        try:
            data = json.loads(config.read_text())
        except ValueError:
            data = None
        perms = data.get("permissions") if isinstance(data, dict) else None
        if isinstance(perms, list) and install_paths.DENY_GRAPH_TOOLS in perms:
            perm = (OK, "graph_* denied to every agent", "")
        else:
            perm = (WARN, f"merge the deny rule into {config}",
                    json.dumps(install_paths.DENY_GRAPH_TOOLS))
    results.append(_result("permissions", "graph_* denied globally", *perm))

    root, reason = server.resolve_project(project, False)
    root_path = Path(root)
    results.append(_result(
        "project", "Project",
        OK if root_path.is_dir() else WARN, f"{root}  ({reason})", "pass --project DIR"))

    graphs_rel = server.detect_graphs_dir(root_path, server.remembered_graphs_dir(root_path))
    graphs_dir = root_path if graphs_rel in ("", ".") else root_path / graphs_rel
    results.append(_result(
        "diagrams", "Diagrams directory",
        OK if graphs_dir.is_dir() else INFO,
        str(graphs_dir) + ("" if graphs_dir.is_dir() else "  (created on first launch)"), ""))

    agents_md = root_path / "AGENTS.md"
    wired = False
    if agents_md.exists():
        try:
            wired = server.MARKER_START in agents_md.read_text(errors="ignore")
        except OSError:
            wired = False
    results.append(_result(
        "awareness", "Agent awareness",
        OK if wired else WARN,
        str(agents_md) if agents_md.exists() else f"no AGENTS.md in {root}",
        "click 'Make agents aware' in the editor"))

    results.append(_result(
        "bridge", f"Bridge on {server.DEFAULT_PORT}", INFO,
        "already running — the editor reuses it" if _health_up(server.DEFAULT_PORT)
        else "not running (normal)", ""))

    return results


def summarize(results: list[dict]) -> dict:
    fails = [r for r in results if r["status"] == FAIL]
    return {
        "ok": sum(1 for r in results if r["status"] == OK),
        "fail": len(fails),
        "warn": sum(1 for r in results if r["status"] == WARN),
        "ready": not fails,
    }


def _glyphs() -> dict:
    encoding = (getattr(sys.stdout, "encoding", "") or "").lower()
    if "utf" in encoding:
        return {OK: "✓", FAIL: "✗", WARN: "!", INFO: "–"}
    return {OK: "+", FAIL: "x", WARN: "!", INFO: "-"}


def render_text(results: list[dict]) -> str:
    glyph = _glyphs()
    lines = ["Siren Studio — setup check", ""]
    for item in results:
        lines.append(f"  {glyph[item['status']]} {item['label']}")
        if item["detail"]:
            lines.append(f"      {item['detail']}")
        if item["remedy"] and item["status"] in (FAIL, WARN):
            lines.append(f"      fix: {item['remedy']}")
    summary = summarize(results)
    plural = "s" if summary["warn"] != 1 else ""
    lines += [
        "",
        f"  {summary['ok']} ok · {summary['fail']} failed · {summary['warn']} warning{plural}",
        "  ready to run" if summary["ready"] else "  fix the failures above, then re-run",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check your Siren Studio setup.")
    parser.add_argument("--check", action="store_true",
                        help="accepted for `start.py --check`; the check is the default")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--project", default=None, help="project root to inspect")
    parser.add_argument("--oc-url", default=None, help="OpenCode URL override")
    args = parser.parse_args(argv)

    results = run_checks(args.project, args.oc_url)
    if args.json:
        print(json.dumps({"checks": results, **summarize(results)}, indent=2))
    else:
        print(render_text(results))
    return 0 if summarize(results)["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
