#!/usr/bin/env python3
"""Verify the graph-engineer permission model end to end.

Runs a throwaway `opencode serve` against the real global config and agent
frontmatter, then checks:

  allow  graph-engineer writes graphs/probe-ok.mmd      -> file exists
  deny   graph-engineer writes probe-perm.txt at root   -> blocked, no file
  deny   graph-engineer runs a shell command            -> blocked
  allow  graph-engineer calls graph.validate            -> verdict returned
  deny   build calls graph.validate                     -> no verdict

The allow cases are the control: without them a blanket failure would look like
success.
"""
import base64
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.request

PORT = int(os.environ.get("TEST_THROWAWAY_PORT", "4099"))
BASE = f"http://127.0.0.1:{PORT}"
TEST_ROOT = os.environ.get("TEST_ROOT", "/tmp/opencode/mermaid-tests")
# The plugin running inside the throwaway server must talk to the same bridge
# this suite simulates the editor on, so point it explicitly rather than relying
# on whichever bridge happens to own the primary registration file.
BRIDGE = os.environ.get("TEST_BASE", "http://127.0.0.1:8788")
LOG = os.path.join(TEST_ROOT, "serve-perm-test.log")
WORKSPACE = os.path.join(TEST_ROOT, "perm-workspace")
SHELL_MARKER = os.path.join(TEST_ROOT, "perm-shell.txt")
results = []


def check(name, cond, extra=""):
    results.append((bool(cond), name, extra))


def post(url, payload, password=""):
    data = json.dumps(payload).encode()
    headers = {"content-type": "application/json"}
    if password:
        token = base64.b64encode(f"opencode:{password}".encode()).decode()
        headers["authorization"] = f"Basic {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=180) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def get(url, password=""):
    headers = {}
    if password:
        token = base64.b64encode(f"opencode:{password}".encode()).decode()
        headers["authorization"] = f"Basic {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=180) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def editor_thread(stop):
    """Act as the open editor so graph.validate can get a real parser verdict."""
    request = urllib.request.Request(f"{BRIDGE}/api/events")
    with urllib.request.urlopen(request, timeout=300) as response:
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
                ok = "unbalanced" not in payload["source"]
                post(f"{BRIDGE}/api/validate-result", {
                    "nonce": payload["nonce"], "ok": ok,
                    "errors": [] if ok else [{"line": 2, "message": "unbalanced '['"}],
                })
                event = None


def tool_blob(messages):
    chunks = []
    for message in messages:
        if message["type"] != "assistant":
            continue
        for part in message.get("content", []):
            if part["type"] == "tool":
                chunks.append(json.dumps(part.get("state", {}).get("input", {})))
    return "\n".join(chunks)


def tool_names(messages):
    """Every tool the agent actually invoked this turn."""
    return {
        part.get("name")
        for message in messages if message["type"] == "assistant"
        for part in message.get("content", [])
        if part["type"] == "tool"
    }


def assistant_text(messages):
    return "\n".join(
        part.get("text") or ""
        for message in messages if message["type"] == "assistant"
        for part in message.get("content", []) if part["type"] == "text"
    )


def tool_output_text(messages):
    """Concatenated text returned *by* the tools, not what the agent said about them."""
    chunks = []
    for message in messages:
        if message["type"] != "assistant":
            continue
        for part in message.get("content", []):
            if part["type"] != "tool":
                continue
            for item in (part.get("state") or {}).get("content", []) or []:
                if isinstance(item, dict) and item.get("type") == "text":
                    chunks.append(item.get("text") or "")
                elif isinstance(item, str):
                    chunks.append(item)
    return "\n".join(chunks)


def run_turn(password, session, prompt, timeout=200):
    """Send a prompt and wait for the whole turn, not the first completed message."""
    post(f"{BASE}/api/session/{session}/prompt", {"text": prompt, "delivery": "steer"},
         password=password)
    deadline = time.time() + timeout
    messages = []
    signature = None
    while time.time() < deadline:
        time.sleep(3)
        messages = get(f"{BASE}/api/session/{session}/context", password=password)["data"]
        assistants = [m for m in messages if m["type"] == "assistant"]
        if not assistants:
            continue
        # stable = no new messages and no new content, 3s apart, and nothing running
        signature_now = (
            len(messages),
            sum(len(m.get("content", [])) for m in assistants),
            len(assistant_text(messages)),
        )
        if signature_now == signature and all(
                m.get("time", {}).get("completed") for m in assistants):
            break
        signature = signature_now
    return messages


def make_session(password, agent, title):
    return post(f"{BASE}/api/session", {
        "title": title, "agent": agent,
        "model": {"providerID": "deepseek", "id": "deepseek-flash"},
        "location": {"directory": WORKSPACE},
    }, password=password)["data"]["id"]


for path in (os.path.join(WORKSPACE, "probe-perm.txt"),
             os.path.join(WORKSPACE, "graphs/probe-ok.mmd"),
             os.path.join(WORKSPACE, "graphs/probe-graphdir.mmd"),
             SHELL_MARKER):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
os.makedirs(TEST_ROOT, exist_ok=True)
os.makedirs(os.path.join(WORKSPACE, "graphs"), exist_ok=True)

log = open(LOG, "w")
server = subprocess.Popen(["opencode", "serve", "--port", str(PORT), "--print-logs"],
                          stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                          env={**os.environ, "MERMAID_STUDIO_URL": BRIDGE})
stop = threading.Event()
thread = threading.Thread(target=editor_thread, args=(stop,), daemon=True)

try:
    password = ""
    for _ in range(60):
        time.sleep(0.5)
        found = re.search(r"server password ([A-Za-z0-9_-]+)", open(LOG).read())
        if found:
            password = found.group(1)
            break
    check("throwaway server started", bool(password))
    thread.start()
    time.sleep(1)

    get(f"{BASE}/api/agent", password=password)
    time.sleep(2)
    log_text = open(LOG).read()
    check("plugin loads without error",
          "graph-tools.js" in log_text and "failed to load plugin" not in log_text,
          "failed" if "failed to load plugin" in log_text else "clean")

    # ── graph-engineer: allow graph write, deny code write and shell ────────
    session = make_session(password, "graph-engineer", "perm test")
    bad_source = "flowchart TD\\n    A[Start --> B\\n"
    prompt = (
        "Do these four things in order and report each result verbatim:\n"
        f"1. Call the graph.validate tool with source \"{bad_source}\".\n"
        "2. Use the write tool to create graphs/probe-ok.mmd containing "
        "\"flowchart TD\\n    A --> B\\n\".\n"
        "3. Use the write tool to create probe-perm.txt at the workspace root "
        "containing \"should not exist\".\n"
        f"4. Use the shell tool to run: echo shell-worked > {SHELL_MARKER}\n"
        "Report exactly what each call returned."
    )
    messages = run_turn(password, session, prompt)
    blob = tool_blob(messages)
    text = assistant_text(messages)

    check("graph-engineer can call graph.validate", "graph.validate" in blob or "graph_validate" in blob,
          blob[:100] or "no tool input")
    output = tool_output_text(messages)
    check("graph.validate returned a parser verdict",
          "checked by" in output.lower(), output.strip()[:160].replace("\n", " "))

    ok_path = os.path.join(WORKSPACE, "graphs/probe-ok.mmd")
    check("ALLOW: graph write landed on disk", os.path.exists(ok_path),
          "graphs/probe-ok.mmd")

    bad_path = os.path.join(WORKSPACE, "probe-perm.txt")
    check("DENY: code write blocked (no file on disk)", not os.path.exists(bad_path),
          "probe-perm.txt absent" if not os.path.exists(bad_path) else "FILE WAS WRITTEN")
    check("DENY: shell had no side effect",
          not os.path.exists(SHELL_MARKER),
          "perm-shell.txt absent" if not os.path.exists(SHELL_MARKER)
          else "SHELL COMMAND RAN")
    print("    graph-engineer said:", text.strip()[:220].replace("\n", " "))

    # ── the editor's usual shape: the Location IS the diagrams directory ────
    # Paths are then bare filenames, which a directory-based rule would miss.
    graphs_session = post(f"{BASE}/api/session", {
        "title": "graphdir perm test", "agent": "graph-engineer",
        "model": {"providerID": "deepseek", "id": "deepseek-flash"},
        "location": {"directory": os.path.join(WORKSPACE, "graphs")},
    }, password=password)["data"]["id"]
    graphs_text = assistant_text(run_turn(
        password, graphs_session,
        "Use the write tool to create probe-graphdir.mmd containing "
        "\"flowchart TD\\n    A --> B\\n\". Then report exactly what happened.",
    ))
    check("ALLOW: write works when the workspace is the diagrams directory",
          os.path.exists(os.path.join(WORKSPACE, "graphs/probe-graphdir.mmd")),
          graphs_text.strip()[:120].replace("\n", " "))

    # ── graph-engineer: the `question` tool is withheld ─────────────────────
    # The editor has no picker for it, so a turn that calls it blocks forever on
    # an answer that cannot arrive. graph.validate is the positive control: if
    # *no* tools came back, a missing `question` would prove nothing.
    question_session = make_session(password, "graph-engineer", "question tool test")
    question_messages = run_turn(
        password, question_session,
        "Do these two things and report each result verbatim:\n"
        "1. Call the graph.validate tool with source \"flowchart TD\\n    A --> B\\n\".\n"
        "2. Call the `question` tool to ask me a one-question multiple-choice question.\n"
        "If you do not have a tool named `question`, do not substitute anything - "
        "reply exactly \"NO QUESTION TOOL\" for step 2 and move on.",
    )
    invoked = tool_names(question_messages)
    question_blob = tool_blob(question_messages)
    question_text = assistant_text(question_messages)
    check("ALLOW: graph.validate still works alongside it",
          "checked by" in tool_output_text(question_messages).lower(),
          ", ".join(sorted(t for t in invoked if t)) or "no tools called")
    # This agent runs in Code Mode, so tools are reached through `execute` and a
    # withheld tool never shows up as a top-level name - the evidence is that the
    # agent cannot write the call, and says so when asked point-blank.
    check("DENY: graph-engineer cannot call the question tool",
          not re.search(r"tools?\.question\b|tools\[\s*[\"']question", question_blob),
          question_blob.strip()[:160].replace("\n", " "))
    check("DENY: and reports it missing when asked to use it",
          bool(re.search(r"no question tool", question_text, re.I)),
          question_text.strip()[:160].replace("\n", " "))
    print("    question turn said:", question_text.strip()[:220].replace("\n", " "))

    # ── build: denied the graph tools ───────────────────────────────────────
    build_session = make_session(password, "build", "build perm test")
    build_text = assistant_text(run_turn(
        password, build_session,
        "Call the graph.validate tool with source \"flowchart TD\\n    A --> B\\n\" "
        "and report the result verbatim. If you do not have that tool, say exactly "
        "\"NO SUCH TOOL\" and list the graph tools you do have.",
    ))
    check("DENY: build did not get a validation verdict",
          "checked by" not in build_text.lower(),
          build_text.strip()[:140].replace("\n", " "))
finally:
    stop.set()
    server.send_signal(signal.SIGTERM)
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
    log.close()

failed = 0
for ok, name, extra in results:
    if not ok:
        failed += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))
print(f"\n{len(results) - failed}/{len(results)} passed")
raise SystemExit(1 if failed else 0)
