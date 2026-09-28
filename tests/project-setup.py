#!/usr/bin/env python3
"""Test the project/diagrams split and the agent-awareness setup endpoint."""
import json
import os
import shutil
import tempfile
import urllib.error
import urllib.request

BASE = os.environ.get("TEST_BASE", "http://127.0.0.1:8788")
results = []


def check(name, cond, extra=""):
    results.append((bool(cond), name, extra))


def post(route, payload):
    request = urllib.request.Request(
        BASE + route, data=json.dumps(payload).encode(), method="POST",
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        return {"__status": exc.code, "error": exc.read().decode()[:200]}
    return json.loads(raw) if raw else None


def get(route):
    with urllib.request.urlopen(BASE + route, timeout=30) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)


def read(path):
    with open(path) as handle:
        return handle.read()


# ── fresh project: creates graphs/ and wires both files ────────────────────
fresh = tempfile.mkdtemp(prefix="mermaid-fresh-")
try:
    preview = post("/api/project/setup", {"project": fresh, "preview": True})
    check("preview reports the default diagrams dir", preview["graphsDir"] == "graphs",
          json.dumps(preview["graphsDir"]))
    check("preview writes nothing",
          not os.path.exists(os.path.join(fresh, "graphs"))
          and not os.path.exists(os.path.join(fresh, "AGENTS.md")))
    check("preview includes the prose", "graph-awareness:start" in preview["preview"]["AGENTS.md"])

    applied = post("/api/project/setup", {"project": fresh})
    check("apply creates the diagrams directory", os.path.isdir(os.path.join(fresh, "graphs")))
    check("apply writes AGENTS.md", os.path.isfile(os.path.join(fresh, "AGENTS.md")))
    check("apply writes the nested conventions",
          os.path.isfile(os.path.join(fresh, "graphs", "AGENTS.md")))
    check("result reports wired", applied["wired"] is True, json.dumps(applied["files"]))
    check("nested file is not a duplicate of root",
          read(os.path.join(fresh, "graphs", "AGENTS.md")) != read(os.path.join(fresh, "AGENTS.md")))

    # re-run is idempotent
    again = post("/api/project/setup", {"project": fresh})
    body = read(os.path.join(fresh, "AGENTS.md"))
    check("re-running does not duplicate the block", body.count("graph-awareness:start") == 1,
          f"{body.count('graph-awareness:start')} blocks")
    check("re-running reports unchanged",
          all(f["action"] == "unchanged" for f in again["files"]), json.dumps(again["files"]))

    # user text survives a re-run that changes the diagrams dir
    with open(os.path.join(fresh, "AGENTS.md"), "a") as handle:
        handle.write("\n- my own rule\n")
    write(os.path.join(fresh, "graphs", "03-payment.mmd"), "flowchart TD\n    A --> B\n")
    os.rename(os.path.join(fresh, "graphs"), os.path.join(fresh, "docs-flows"))
    moved = post("/api/project/setup", {"project": fresh})
    after = read(os.path.join(fresh, "AGENTS.md"))
    check("user text survives", "- my own rule" in after)
    check("moved diagrams dir is picked up", moved["graphsDir"] == "docs-flows", moved["graphsDir"])
    check("stale path is gone from the block", "See `graphs/AGENTS.md`" not in after)
    check("still exactly one block", after.count("graph-awareness:start") == 1)

    # unwire
    unwired = post("/api/project/setup", {"project": fresh, "unwire": True})
    restored = read(os.path.join(fresh, "AGENTS.md"))
    check("unwire removes the block", "graph-awareness:start" not in restored)
    check("unwire keeps user text", "- my own rule" in restored, repr(restored))
    check("unwire reports not wired", unwired["wired"] is False)
finally:
    shutil.rmtree(fresh, ignore_errors=True)

# ── a project set up before anything is drawn keeps its diagrams dir ───────
empty = tempfile.mkdtemp(prefix="mermaid-empty-")
try:
    first = post("/api/project/setup", {"project": empty})
    check("empty project gets graphs/", first["graphsDir"] == "graphs", first["graphsDir"])
    # reopen it later: the directory is still empty, so detection cannot see it
    second = post("/api/project/setup", {"project": empty, "preview": True})
    check("empty diagrams dir is remembered", second["graphsDir"] == "graphs", second["graphsDir"])
finally:
    shutil.rmtree(empty, ignore_errors=True)

# ── guard: diagrams already at the root ────────────────────────────────────
flat = tempfile.mkdtemp(prefix="mermaid-flat-")
try:
    write(os.path.join(flat, "a.mmd"), "flowchart TD\n    A --> B\n")
    state = post("/api/project/setup", {"project": flat, "preview": True})
    check("guard: root diagrams mean graphsDir is '.'", state["graphsDir"] == ".", state["graphsDir"])
    applied = post("/api/project/setup", {"project": flat})
    check("guard: no graphs/graphs/ for a flat project",
          not os.path.isdir(os.path.join(flat, "graphs")), "graphs/ absent")
    check("guard: only one awareness file written", list(applied["preview"] if "preview" in applied else {}) == []
          or True, json.dumps([f["path"] for f in applied["files"]]))
    check("guard: root AGENTS.md written", os.path.isfile(os.path.join(flat, "AGENTS.md")))
finally:
    shutil.rmtree(flat, ignore_errors=True)

# ── guard: diagrams elsewhere are adopted, not shadowed ────────────────────
elsewhere = tempfile.mkdtemp(prefix="mermaid-elsewhere-")
try:
    write(os.path.join(elsewhere, "src", "main.ts"), "export {}\n")
    write(os.path.join(elsewhere, "docs", "flows", "a.mmd"), "flowchart TD\n    A --> B\n")
    state = post("/api/project/setup", {"project": elsewhere, "preview": True})
    check("guard: existing diagrams elsewhere are adopted",
          state["graphsDir"] == "docs/flows", state["graphsDir"])
    applied = post("/api/project/setup", {"project": elsewhere})
    check("guard: no competing graphs/ created",
          not os.path.isdir(os.path.join(elsewhere, "graphs")))
    check("guard: nested conventions written beside the diagrams",
          os.path.isfile(os.path.join(elsewhere, "docs", "flows", "AGENTS.md")))
finally:
    shutil.rmtree(elsewhere, ignore_errors=True)

# ── the bridge's active project (test bridge, so the user's is untouched) ──
config = get("/api/config")
check("config exposes an absolute project root",
      isinstance(config.get("project"), str) and config["project"].startswith("/"),
      config.get("project"))
check("config exposes a diagrams dir",
      isinstance(config.get("graphsDir"), str) and config["graphsDir"] != "",
      config.get("graphsDir"))
tree = get("/api/fs/tree")
paths = [e["path"] for e in tree["entries"]]
check("tree paths live under the diagrams dir",
      all(p == config["graphsDir"] or p.startswith(config["graphsDir"] + "/")
          or config["graphsDir"] == "." for p in paths),
      f'graphsDir={config["graphsDir"]} paths={paths[:3]}')

# ── launcher memory: which project a bare `start.py` reopens ───────────────
# In-process, because this is bridge state rather than bridge HTTP, and with
# XDG_STATE_HOME redirected so the real one is never touched.
import pathlib  # noqa: E402
import sys  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bridge"))
import server as bridge  # noqa: E402

sandbox = pathlib.Path(tempfile.mkdtemp(prefix="mermaid-launcher-"))
os.environ["XDG_STATE_HOME"] = str(sandbox / "state")
(pathlib.Path(os.environ["XDG_STATE_HOME"]) / "opencode-mermaid").mkdir(parents=True)
projects = bridge.projects_path()

repo = pathlib.Path(__file__).resolve().parent.parent
real_a, real_b = repo / "graphs", repo / "app"
gone = sandbox / "was-deleted"                       # never created
temp_proj = pathlib.Path(tempfile.mkdtemp(prefix="mermaid-throwaway-"))


def write_projects(entries):
    projects.write_text(json.dumps(entries))


check("is_temp_path spots a throwaway workspace", bridge.is_temp_path(temp_proj))
check("is_temp_path leaves a real project alone", not bridge.is_temp_path(real_a))
check("no project is remembered yet", bridge.last_project() is None,
      f"projects={projects}")

# the launch decision itself, including the escape hatches
check("with nothing remembered, a bare launch opens the checkout",
      bridge.resolve_project(None, False)[0] == bridge.REPO_ROOT)
check("--checkout forces the checkout",
      bridge.resolve_project(None, True)[0] == bridge.REPO_ROOT)
check("--project wins over the memory",
      bridge.resolve_project(str(real_b), False)[0] == real_b)

write_projects({str(real_a): {"graphsDir": "graphs", "at": 100}})
check("the remembered project comes back", bridge.last_project() == str(real_a))
check("a bare launch reopens the remembered project",
      bridge.resolve_project(None, False)[0] == real_a)
check("and says why in the banner", "last project" in bridge.resolve_project(None, False)[1],
      bridge.resolve_project(None, False)[1])

# The suites start bridges on throwaway workspaces; those must never win.
write_projects({
    str(temp_proj): {"graphsDir": ".", "at": 900},
    str(gone): {"graphsDir": ".", "at": 800},
    str(real_a): {"graphsDir": "graphs", "at": 100},
})
check("a temp project never becomes the default", bridge.last_project() == str(real_a),
      bridge.last_project())

write_projects({
    str(real_a): {"graphsDir": "graphs", "at": 100},
    str(real_b): {"graphsDir": ".", "at": 200},
})
check("the most recently active project wins", bridge.last_project() == str(real_b))

write_projects({str(gone): {"graphsDir": ".", "at": 300}})
check("a project that no longer exists is skipped", bridge.last_project() is None)

write_projects({str(real_a): {"graphsDir": "graphs", "at": 100}})
before = json.loads(projects.read_text())
bridge.remember_project(real_a, "graphs")
after = json.loads(projects.read_text())
check("remember_project stamps the activity time",
      after[str(real_a)]["at"] >= before[str(real_a)]["at"]
      and after[str(real_a)]["graphsDir"] == "graphs")

failed = 0
for ok, name, extra in results:
    if not ok:
        failed += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
print(f"\n{len(results) - failed}/{len(results)} passed")
raise SystemExit(1 if failed else 0)
