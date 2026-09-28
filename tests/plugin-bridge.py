#!/usr/bin/env python3
"""Test the plugin-facing bridge API: the editor validation round-trip and focus.

A background thread acts as the open editor: it subscribes to /api/events and
answers validate-request with a canned "real Mermaid parser" verdict.
"""
import json
import threading
import os
import time
import urllib.request

BASE = os.environ.get("TEST_BASE", "http://127.0.0.1:8788")
results = []


def check(name, cond, extra=""):
    results.append((bool(cond), name, extra))


def post(route, payload):
    request = urllib.request.Request(
        BASE + route, data=json.dumps(payload).encode(), method="POST",
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def stream_events(answers, stop):
    """Consume SSE and answer validate requests like the browser does."""
    request = urllib.request.Request(BASE + "/api/events")
    with urllib.request.urlopen(request, timeout=60) as response:
        event = None
        while not stop.is_set():
            line = response.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip("\n")
            if text.startswith("event: "):
                event = text[7:]
            elif text.startswith("data: ") and event == "validate-request":
                payload = json.loads(text[6:])
                answers.append(payload)
                post("/api/validate-result", {
                    "nonce": payload["nonce"],
                    "ok": False,
                    "errors": [{"line": 7, "message": "canned parser verdict"}],
                })
                event = None


def get(route):
    with urllib.request.urlopen(BASE + route, timeout=15) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


# use whatever diagram the bridge actually has, so this suite is independent of
# which project the editor is pointed at
_tree = get("/api/fs/tree")["entries"]
_real = next((e["path"] for e in _tree
              if e["type"] == "file" and e["path"].endswith((".mmd", ".mermaid"))), None)
if _real is None:
    raise SystemExit("no diagram in the test bridge's workspace")
_missing = _real.rsplit(".", 1)[0] + "-does-not-exist.mmd"
print(f"using diagram: {_real}")

answers = []
stop = threading.Event()
thread = threading.Thread(target=stream_events, args=(answers, stop), daemon=True)
thread.start()
time.sleep(1.0)

# 1. with an editor attached, the real parser verdict wins
result = post("/api/validate", {"source": "flowchart TD\n    A[Start] --> B\n"})
check("round-trip reaches the editor", len(answers) == 1, f"{len(answers)} request(s)")
check("verdict comes from the real parser", result["checked_by"] == "mermaid",
      json.dumps(result))
check("parser errors are returned", result["errors"] == [{"line": 7, "message": "canned parser verdict"}],
      json.dumps(result["errors"]))

# 2. focus reports delivery to the connected editor
focus = post("/api/focus", {"path": _real})
check("focus reports delivery", focus.get("delivered", 0) >= 1, json.dumps(focus))

# 3. determinism: the editor also sees a request for a valid-looking source
post("/api/validate", {"source": "flowchart TD\n    A --> B\n"})
check("second round-trip also reaches the editor", len(answers) == 2, f"{len(answers)}")

# 4. with the editor gone, it falls back to structural lint
stop.set()
time.sleep(1.2)
fallback = post("/api/validate", {"path": _real})
check("falls back to structural lint when no editor is open",
      fallback["checked_by"] == "structural" and fallback["ok"] is True,
      json.dumps(fallback))

# 5. a valid workspace file passes structural lint
good = post("/api/validate", {"path": _real})
check("valid file reports no errors", good["ok"] and good["errors"] == [], json.dumps(good))

# 6. an unknown path is rejected clearly
try:
    post("/api/validate", {"path": _missing})
    check("missing file is an error", False, "no exception")
except urllib.error.HTTPError as exc:
    check("missing file is an error", exc.code == 400, f"HTTP {exc.code}")

# 7. the size advisory: advice for the agent, never an error
big = "flowchart TD\n" + "\n".join(f"    n{i}[Node {i}]" for i in range(26)) + "\n"
small = "flowchart TD\n" + "\n".join(f"    n{i}[Node {i}]" for i in range(10)) + "\n"
big_result = post("/api/validate", {"source": big})
small_result = post("/api/validate", {"source": small})
big_warns = [w["message"] for w in big_result["warnings"] if "splitting" in w["message"]]
check("size advisory fires past 25 nodes", bool(big_warns), big_warns[:1])
check("size advisory stays a warning, not an error", big_result["ok"] is True)
check("size advisory is silent for a small graph",
      not [w for w in small_result["warnings"] if "splitting" in w["message"]],
      json.dumps(small_result["warnings"]))

failed = 0
for ok, name, extra in results:
    if not ok:
        failed += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
print(f"\n{len(results) - failed}/{len(results)} passed")
raise SystemExit(1 if failed else 0)
