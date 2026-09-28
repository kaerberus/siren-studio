#!/usr/bin/env python3
"""opencode-mermaid local bridge.

A dependency-free (Python stdlib only) local server that:

  * serves the editor app from ../app
  * reverse-proxies the OpenCode HTTP API (adding basic auth, streaming SSE)
  * exposes a small filesystem API scoped to a workspace directory
  * watches the workspace and pushes change/focus events to the editor over SSE

Run ``python3 bridge/server.py`` or use the ``start.py`` launcher.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import parse_qs, unquote, urlparse

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_DIR = REPO_ROOT / "app"
VERSION = "0.1.0"

# Files/dirs never surfaced to the editor or watched for changes.
IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".history",
    ".venv", "venv", "dist", "build", ".cache", ".idea", ".vscode",
}
GRAPH_EXTS = {".mmd", ".mermaid", ".md"}
DEFAULT_AGENT = "graph-engineer"
DEFAULT_MODEL = "deepseek/deepseek-flash"
DEFAULT_PORT = 8777


def parse_model_ref(spec: str | None) -> dict | None:
    """Parse ``provider/model#variant`` into a Model.Ref, or None."""
    text = (spec or "").strip()
    if not text or "/" not in text:
        return None
    variant = None
    if "#" in text:
        text, variant = text.split("#", 1)
    provider, model = text.split("/", 1)
    provider, model = provider.strip(), model.strip()
    if not provider or not model:
        return None
    ref = {"providerID": provider, "id": model}
    if variant and variant.strip():
        ref["variant"] = variant.strip()
    return ref

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")


# --------------------------------------------------------------------------- #
# OpenCode service discovery
# --------------------------------------------------------------------------- #
def _candidate_service_files() -> list[Path]:
    home = Path.home()
    files = []
    state = os.environ.get("XDG_STATE_HOME")
    if state:
        files.append(Path(state) / "opencode" / "service.json")
    files.append(home / ".local" / "state" / "opencode" / "service.json")
    files.append(home / ".config" / "opencode" / "service.json")
    return files


def discover_service() -> dict | None:
    """Return {'url','password','version','pid'} for a running service, if any."""
    for path in _candidate_service_files():
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not data.get("url") or not data.get("password"):
            continue
        return {
            "url": data["url"].rstrip("/"),
            "password": data["password"],
            "version": data.get("version", ""),
            "pid": data.get("pid"),
            "source": str(path),
        }
    return None


DIAGRAM_KEYWORDS = {
    "flowchart", "graph", "sequencediagram", "classdiagram", "classdiagram-v2",
    "statediagram", "statediagram-v2", "erdiagram", "journey", "gantt", "pie",
    "mindmap", "timeline", "gitgraph", "quadrantchart", "requirementdiagram",
    "c4context", "c4container", "c4component", "c4dynamic", "block-beta",
    "sankey-beta", "xychart-beta", "packet-beta", "architecture-beta", "zenuml",
}
RESERVED_IDS = {"end", "graph", "class", "classdef", "style", "click", "subgraph",
                "linkstyle"}


def lint_mermaid(source: str) -> dict:
    """Cheap structural lint for Mermaid source.

    Not a parser: it catches the mistakes that actually bite (missing diagram
    keyword, unbalanced brackets, unclosed quotes, reserved ids, stray `end`).
    The editor can upgrade this to a real `mermaid.parse` result.
    """
    errors: list[dict] = []
    warnings: list[dict] = []
    lines = (source or "").split("\n")

    def add(bucket, line, message):
        bucket.append({"line": line, "message": message})

    # 1. first meaningful line must name a diagram type
    header_index = None
    for index, raw in enumerate(lines):
        text = raw.strip()
        if not text or text.startswith("%%"):
            continue
        header_index = index
        keyword = re.split(r"[\s{(\[]", text, maxsplit=1)[0].lower()
        if keyword not in DIAGRAM_KEYWORDS:
            add(errors, index + 1,
                f"first line should name a diagram type (found {text[:40]!r})")
        break

    if header_index is None:
        add(errors, 1, "diagram is empty")
        return {"errors": errors, "warnings": warnings}

    body = [ln for i, ln in enumerate(lines)
            if i != header_index and ln.strip() and not ln.strip().startswith("%%")]
    if not body:
        add(errors, header_index + 1, "diagram has a type but no content")

    # 2. balanced brackets, ignoring quoted spans. A quote never spans a line in
    #    Mermaid, so an odd number of them on a line is an unclosed label.
    pairs = {"]": "[", ")": "(", "}": "{"}
    stack: list[tuple[str, int]] = []
    for index, raw in enumerate(lines):
        if raw.count('"') % 2 == 1:
            add(errors, index + 1, "unclosed double quote")
        unquoted = []
        in_quote = False
        for ch in raw:
            if ch == '"':
                in_quote = not in_quote
                continue
            if not in_quote:
                unquoted.append(ch)
        for ch in unquoted:
            if ch in "[({":
                stack.append((ch, index + 1))
            elif ch in "])}":
                if not stack or stack[-1][0] != pairs[ch]:
                    add(errors, index + 1, f"unexpected {ch!r}")
                else:
                    stack.pop()
    for opener, line in stack:
        add(errors, line, f"unclosed {opener!r}")

    # 3. reserved words used as node ids, and stray `end`
    subgraphs = 0
    ends = 0
    reserved = "|".join(sorted(RESERVED_IDS))
    for index, raw in enumerate(lines):
        text = raw.strip()
        if not text or text.startswith("%%"):
            continue
        # Mermaid keywords are lowercase, so `End` or `Class` are legal ids.
        if re.match(r"^subgraph\b", text):
            subgraphs += 1
        elif re.match(r"^end\b", text):
            ends += 1
        for match in re.finditer(rf"(?:^|[\s|>])({reserved})\s*[\[\(\{{]", text):
            add(warnings, index + 1,
                f"{match.group(1)!r} is a reserved word used as a node id")

    if subgraphs != ends:
        add(warnings, header_index + 1,
            f"{subgraphs} subgraph(s) but {ends} end(s)")

    # 4. unquoted special characters inside a label
    for index, raw in enumerate(lines):
        if raw.strip().startswith("%%"):
            continue
        for match in re.finditer(r"\[([^\"]*?)\]", raw):
            label = match.group(1)
            if any(ch in label for ch in ";#%"):
                add(warnings, index + 1,
                    "label contains ; # or % without quotes")
                break

    return {"errors": errors, "warnings": warnings}


def state_dir() -> Path:
    state = os.environ.get("XDG_STATE_HOME")
    if state:
        return Path(state) / "opencode-mermaid"
    return Path.home() / ".local" / "state" / "opencode-mermaid"


def registration_path(port: int | None = None) -> Path:
    """`bridge.json` is the primary pointer; `bridge-<port>.json` is per instance."""
    return state_dir() / (f"bridge-{port}.json" if port else "bridge.json")


def pid_alive(pid) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_json_file(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def detect_native_picker() -> str | None:
    """Prefer the desktop's own folder chooser when one is available."""
    if shutil.which("kdialog"):
        return "kdialog"
    if shutil.which("zenity"):
        return "zenity"
    return None


class OpenCode:
    """Thin client for the OpenCode HTTP API with basic auth."""

    def __init__(self) -> None:
        self.url = ""
        self._auth = ""
        self.info: dict | None = None

    def configure(self, discovery: dict | None, explicit_url: str | None) -> None:
        if explicit_url:
            # Explicit URL: still try to reuse a password we discovered.
            pw = (discovery or {}).get("password", "")
            self.url = explicit_url.rstrip("/")
            self._auth = self._basic("opencode", pw)
            return
        if discovery:
            self.url = discovery["url"]
            self._auth = self._basic("opencode", discovery["password"])
        else:
            self.url = ""
            self._auth = ""

    @staticmethod
    def _basic(user: str, password: str) -> str:
        raw = f"{user}:{password}".encode()
        return "Basic " + base64.b64encode(raw).decode()

    @property
    def configured(self) -> bool:
        return bool(self.url)

    def headers(self) -> dict:
        h = {"accept": "application/json"}
        if self._auth:
            h["authorization"] = self._auth
        return h

    def open(self, method: str, path: str, body: bytes | None = None,
             content_type: str | None = None, timeout: float = 30):
        """Open a raw upstream response (caller must close)."""
        url = self.url + path
        headers = self.headers()
        if content_type:
            headers["content-type"] = content_type
        req = urlrequest.Request(url, data=body, headers=headers, method=method)
        return urlrequest.urlopen(req, timeout=timeout)

    def json(self, method: str, path: str, payload: dict | None = None,
             timeout: float = 30):
        body = json.dumps(payload).encode() if payload is not None else None
        resp = self.open(method, path, body, "application/json" if body else None, timeout)
        with resp:
            data = resp.read()
        return json.loads(data) if data else None

    def health(self) -> tuple[bool, str]:
        if not self.configured:
            return False, "no service discovered"
        try:
            info = self.json("GET", "/api/info", timeout=5)
            self.info = info
            return True, info.get("version", "")
        except Exception as exc:  # noqa: BLE001 - surface any discovery failure
            return False, str(exc)


# --------------------------------------------------------------------------- #
# Event hub (SSE fan-out)
# --------------------------------------------------------------------------- #
class Hub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: set[queue.Queue] = set()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=256)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    def publish(self, event: str, data: dict) -> None:
        payload = {"event": event, "data": data}
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

    def count(self) -> int:
        with self._lock:
            return len(self._subs)


class Validator:
    """Ask a connected editor to validate source with the real Mermaid parser.

    The bridge cannot parse Mermaid itself; the browser can. We publish a
    request over SSE and wait (briefly) for the editor to post the result back.
    """

    def __init__(self, hub: Hub) -> None:
        self.hub = hub
        self._lock = threading.Lock()
        self._pending: dict[str, dict] = {}

    def available(self) -> bool:
        return self.hub.count() > 0

    def request(self, source: str, timeout: float = 4.0) -> dict | None:
        if not self.available():
            return None
        nonce = uuid.uuid4().hex
        box = {"event": threading.Event(), "result": None}
        with self._lock:
            self._pending[nonce] = box
        self.hub.publish("validate-request", {"nonce": nonce, "source": source})
        got = box["event"].wait(timeout)
        with self._lock:
            self._pending.pop(nonce, None)
        return box["result"] if got else None

    def resolve(self, nonce: str, result: dict) -> bool:
        with self._lock:
            box = self._pending.get(nonce)
        if not box:
            return False
        box["result"] = result
        box["event"].set()
        return True


# --------------------------------------------------------------------------- #
# Workspace
# --------------------------------------------------------------------------- #
class Workspace:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self._local_writes: dict[str, float] = {}
        self._lock = threading.Lock()

    def set_root(self, root: Path) -> None:
        self.root = root.resolve()

    def resolve(self, rel: str, must_exist: bool = False) -> Path:
        rel = (rel or "").strip().lstrip("/")
        candidate = (self.root / rel).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise ValueError("path escapes workspace")
        if must_exist and not candidate.exists():
            raise FileNotFoundError(rel)
        return candidate

    def rel(self, path: Path) -> str:
        return str(path.resolve().relative_to(self.root)).replace(os.sep, "/")

    def note_local_write(self, path: Path, mtime: float) -> None:
        with self._lock:
            self._local_writes[self.rel(path)] = mtime

    def take_local_write(self, rel: str, mtime: float) -> bool:
        with self._lock:
            known = self._local_writes.get(rel)
            if known is not None and abs(known - mtime) < 1e-6:
                del self._local_writes[rel]
                return True
        return False

    def tree(self, max_files: int = 4000) -> list[dict]:
        entries: list[dict] = []
        count = 0

        def walk(directory: Path) -> None:
            nonlocal count
            if count >= max_files:
                return
            try:
                children = sorted(
                    directory.iterdir(),
                    key=lambda p: (p.is_file(), p.name.lower()),
                )
            except OSError:
                return
            for child in children:
                if count >= max_files:
                    return
                if child.name.startswith(".") and child.name != ".opencode":
                    if child.is_dir():
                        continue
                if child.is_dir():
                    if child.name in IGNORED_DIRS:
                        continue
                    entries.append({"type": "dir", "path": self.rel(child),
                                    "name": child.name})
                    walk(child)
                else:
                    if child.name in IGNORED_DIRS:
                        continue
                    count += 1
                    try:
                        st = child.stat()
                    except OSError:
                        continue
                    entries.append({
                        "type": "file",
                        "path": self.rel(child),
                        "name": child.name,
                        "size": st.st_size,
                        "mtime": st.st_mtime,
                        "graph": child.suffix.lower() in GRAPH_EXTS,
                    })

        walk(self.root)
        return entries

    def snapshot(self) -> dict[str, tuple[float, int]]:
        snap: dict[str, tuple[float, int]] = {}
        for entry in self.tree():
            if entry["type"] == "file":
                snap[entry["path"]] = (entry["mtime"], entry["size"])
        return snap


class Watcher(threading.Thread):
    def __init__(self, workspace: Workspace, hub: Hub, interval: float = 1.0) -> None:
        super().__init__(daemon=True)
        self.workspace = workspace
        self.hub = hub
        self.interval = interval
        self._stop = threading.Event()
        self._prev = workspace.snapshot()

    def stop(self) -> None:
        self._stop.set()

    def _rebaseline(self) -> None:
        self._prev = self.workspace.snapshot()

    def run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                current = self.workspace.snapshot()
            except Exception:  # noqa: BLE001
                continue
            prev = self._prev
            for path, meta in current.items():
                old = prev.get(path)
                if old is None:
                    self.hub.publish("file-created",
                                     {"path": path, "mtime": meta[0]})
                elif abs(old[0] - meta[0]) > 1e-6 or old[1] != meta[1]:
                    origin = "editor" if self.workspace.take_local_write(path, meta[0]) else "external"
                    self.hub.publish("file-changed",
                                     {"path": path, "mtime": meta[0], "origin": origin})
            for path in prev:
                if path not in current:
                    self.hub.publish("file-deleted", {"path": path})
            self._prev = current


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"opencode-mermaid/{VERSION}"

    # ---- accessors backed by the owning server ----
    @property
    def workspace(self) -> "Workspace":
        return self.server.workspace  # type: ignore[attr-defined]

    @property
    def hub(self) -> "Hub":
        return self.server.hub  # type: ignore[attr-defined]

    @property
    def oc(self) -> "OpenCode":
        return self.server.oc  # type: ignore[attr-defined]

    # ------------------------------------------------------------------ utils
    def log_message(self, fmt: str, *args) -> None:  # quieter default logging
        if os.environ.get("BRIDGE_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: bytes = b"", content_type: str = "application/json",
              extra: dict | None = None) -> None:
        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, payload, status: int = 200) -> None:
        self._send(status, json.dumps(payload).encode(), "application/json")

    def _error(self, status: int, message: str) -> None:
        self._json({"error": message}, status)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _read_json(self) -> dict:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            return {}

    # ------------------------------------------------------------- dispatching
    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path.startswith("/oc/"):
                return self._proxy(method, path[3:], query)
            if path == "/health":
                ok, ver = self.oc.health()
                return self._json({"ok": True, "oc": {"ok": ok, "version": ver}})
            if path == "/api/config" and method == "GET":
                return self._handle_config()
            if path == "/api/fs/tree" and method == "GET":
                return self._json({"root": str(self.workspace.root),
                                   "entries": self.workspace.tree()})
            if path == "/api/fs/file" and method == "GET":
                return self._handle_read(query)
            if path == "/api/fs/file" and method == "PUT":
                return self._handle_write()
            if path == "/api/fs/file" and method == "DELETE":
                return self._handle_delete(query)
            if path == "/api/fs/move" and method == "POST":
                return self._handle_move()
            if path == "/api/fs/dirs" and method == "GET":
                return self._handle_dirs(query)
            if path == "/api/fs/mkdir" and method == "POST":
                return self._handle_mkdir()
            if path == "/api/pick-directory" and method == "POST":
                return self._handle_pick_directory()
            if path == "/api/validate" and method == "POST":
                return self._handle_validate()
            if path == "/api/validate-result" and method == "POST":
                return self._handle_validate_result()
            if path == "/api/workspace" and method == "POST":
                return self._handle_set_workspace()
            if path == "/api/events" and method == "GET":
                return self._handle_events()
            if path == "/api/focus" and method == "POST":
                return self._handle_focus()
            if path == "/api/open" and method == "POST":
                return self._handle_open()
            if method in ("GET", "HEAD"):
                return self._serve_static(path)
            return self._error(404, f"no route for {method} {path}")
        except ValueError as exc:
            self._error(400, str(exc))
        except FileNotFoundError as exc:
            self._error(404, f"not found: {exc}")
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001
            self._error(500, f"{type(exc).__name__}: {exc}")

    # ------------------------------------------------------------- config/health
    def _handle_config(self) -> None:
        ok, ver = self.oc.health()
        agents: list[dict] = []
        if ok:
            # A busy OpenCode can take a while to answer; retry once rather than
            # reporting "no agents" and hiding the Graph Engineer.
            for attempt in range(2):
                try:
                    listing = self.oc.json("GET", "/api/agent", timeout=20)
                    for agent in (listing or {}).get("data", []):
                        agents.append({
                            "id": agent.get("id"),
                            "name": agent.get("name"),
                            "mode": agent.get("mode"),
                            "hidden": agent.get("hidden", False),
                        })
                    break
                except Exception:  # noqa: BLE001
                    agents = []
                    if attempt == 0:
                        time.sleep(0.4)
        self._json({
            "version": VERSION,
            "workspace": str(self.workspace.root),
            "workspaceName": self.workspace.root.name,
            "oc": {
                "ok": ok,
                "version": ver,
                "url": self.oc.url,
                "configured": self.oc.configured,
                "agents": agents,
            },
            "defaultAgent": DEFAULT_AGENT,
            "defaultModel": getattr(self.server, "default_model", None),
            "nativePicker": getattr(self.server, "native_picker", None),
            "home": str(Path.home()),
        })

    # ------------------------------------------------------------------ fs api
    def _handle_read(self, query: dict) -> None:
        rel = (query.get("path") or [""])[0]
        path = self.workspace.resolve(unquote(rel), must_exist=True)
        if path.is_dir():
            return self._json({"path": self.workspace.rel(path),
                               "entries": self.workspace.tree()})
        st = path.stat()
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return self._error(415, "binary file")
        self._json({"path": self.workspace.rel(path), "content": content,
                    "mtime": st.st_mtime, "size": st.st_size})

    def _handle_write(self) -> None:
        payload = self._read_json()
        rel = payload.get("path", "")
        content = payload.get("content", "")
        path = self.workspace.resolve(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        st = path.stat()
        self.workspace.note_local_write(path, st.st_mtime)
        self.hub.publish("file-changed",
                         {"path": self.workspace.rel(path), "mtime": st.st_mtime,
                          "origin": "editor"})
        self._json({"path": self.workspace.rel(path), "mtime": st.st_mtime,
                    "size": st.st_size})

    def _handle_delete(self, query: dict) -> None:
        rel = (query.get("path") or [""])[0]
        path = self.workspace.resolve(unquote(rel), must_exist=True)
        if path.is_dir():
            return self._error(400, "refusing to delete a directory")
        path.unlink()
        self.hub.publish("file-deleted", {"path": self.workspace.rel(path)})
        self._json({"ok": True})

    def _handle_move(self) -> None:
        payload = self._read_json()
        src = self.workspace.resolve(payload.get("from", ""), must_exist=True)
        dst = self.workspace.resolve(payload.get("to", ""))
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        self.hub.publish("file-deleted", {"path": self.workspace.rel(src)})
        self.hub.publish("file-created", {"path": self.workspace.rel(dst)})
        self._json({"from": self.workspace.rel(src), "to": self.workspace.rel(dst)})

    def _handle_set_workspace(self) -> None:
        payload = self._read_json()
        raw = os.path.expanduser(payload.get("dir", ""))
        target = Path(raw)
        if not target.is_absolute():
            target = (self.workspace.root / target)
        target = target.resolve()
        if not target.is_dir():
            return self._error(400, f"not a directory: {target}")
        self.workspace.set_root(target)
        self.server.watcher._rebaseline()  # type: ignore[attr-defined]
        write_registration(self.server, str(target))
        self.hub.publish("workspace-changed", {"root": str(target)})
        self._json({"workspace": str(target)})

    def _handle_dirs(self, query: dict) -> None:
        """Browse directories anywhere on the machine (loopback, single user).

        Used by the workspace picker; unlike the workspace API this is not
        confined to the workspace root, so the user can pick a new one.
        """
        raw = (query.get("path") or [""])[0]
        target = Path(os.path.expanduser(unquote(raw))).resolve() if raw else Path.home()
        if not target.is_dir():
            return self._error(400, f"not a directory: {target}")
        home = Path.home()
        entries = []
        try:
            for child in target.iterdir():
                try:
                    if child.is_dir():
                        entries.append({"name": child.name, "path": str(child),
                                        "hidden": child.name.startswith(".")})
                except OSError:
                    continue
        except PermissionError:
            return self._error(403, f"permission denied: {target}")
        entries.sort(key=lambda e: (e["hidden"], e["name"].lower()))
        shortcuts = [{"name": s, "path": str(home / s)}
                     for s in ("Projects", "Documents", "Downloads", "Desktop")
                     if (home / s).is_dir()]
        self._json({
            "path": str(target),
            "parent": str(target.parent) if target.parent != target else None,
            "home": str(home),
            "dirs": entries[:2000],
            "shortcuts": shortcuts,
        })

    def _handle_mkdir(self) -> None:
        payload = self._read_json()
        base = Path(os.path.expanduser(payload.get("path") or "")).resolve()
        name = (payload.get("name") or "").strip()
        if not base.is_dir():
            return self._error(400, f"not a directory: {base}")
        if not name or name in (".", "..") or os.sep in name or name.startswith("~"):
            return self._error(400, "invalid folder name")
        target = base / name
        if target.exists():
            return self._error(409, f"already exists: {target.name}")
        try:
            target.mkdir()
        except OSError as exc:
            return self._error(500, str(exc))
        self._json({"path": str(target)})

    def _handle_pick_directory(self) -> None:
        """Ask the desktop's own folder chooser (kdialog/zenity)."""
        picker = getattr(self.server, "native_picker", None)
        if not picker:
            return self._error(501, "no system folder chooser available")
        payload = self._read_json()
        start = os.path.expanduser(payload.get("start") or str(self.workspace.root))
        if not os.path.isdir(start):
            start = str(Path.home())
        cmd = (["kdialog", "--getexistingdirectory", start] if picker == "kdialog"
               else ["zenity", "--file-selection", "--directory", f"--filename={start}/"])
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        except FileNotFoundError:
            return self._error(501, f"{picker} is not available")
        except subprocess.TimeoutExpired:
            return self._json({"cancelled": True, "reason": "timeout"})
        if proc.returncode != 0:
            return self._json({"cancelled": True})
        chosen = (proc.stdout or "").strip()
        if not chosen:
            return self._json({"cancelled": True})
        target = Path(chosen).resolve()
        if not target.is_dir():
            return self._error(400, f"not a directory: {target}")
        self._json({"path": str(target)})

    def _handle_validate(self) -> None:
        """Structural lint always; the editor's real parser when it is open."""
        payload = self._read_json()
        source = payload.get("source")
        path = payload.get("path")
        if source is None and path:
            try:
                source = self.workspace.resolve(path, must_exist=True).read_text("utf-8")
            except (OSError, ValueError) as exc:
                return self._error(400, f"cannot read {path}: {exc}")
        source = source or ""
        structural = lint_mermaid(source)
        result = {
            "ok": not structural["errors"],
            "checked_by": "structural",
            "errors": structural["errors"],
            "warnings": structural["warnings"],
        }
        real = getattr(self.server, "validator", None)
        if real is not None:
            answer = real.request(source)
            if answer is not None:
                result["ok"] = bool(answer.get("ok"))
                result["checked_by"] = "mermaid"
                result["errors"] = answer.get("errors", [])
                if structural["warnings"]:
                    result["warnings"] = structural["warnings"]
        self._json(result)

    def _handle_validate_result(self) -> None:
        payload = self._read_json()
        validator = getattr(self.server, "validator", None)
        accepted = bool(validator and validator.resolve(
            payload.get("nonce", ""),
            {"ok": bool(payload.get("ok")), "errors": payload.get("errors", [])},
        ))
        self._json({"accepted": accepted})

    def _handle_focus(self) -> None:
        payload = self._read_json()
        self.hub.publish("focus", {"path": payload.get("path", "")})
        self._json({"ok": True, "delivered": self.hub.count()})

    def _handle_open(self) -> None:
        """Open a path in the OS file manager (used by the UI)."""
        payload = self._read_json()
        path = self.workspace.resolve(payload.get("path", ""), must_exist=True)
        target = path if path.is_dir() else path.parent
        try:
            import subprocess
            opener = "open" if sys.platform == "darwin" else "xdg-open"
            subprocess.Popen([opener, str(target)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:  # noqa: BLE001
            return self._error(500, str(exc))
        self._json({"ok": True})

    # --------------------------------------------------------------- sse
    def _handle_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = self.hub.subscribe()
        try:
            self._write_sse("ready", {"root": str(self.workspace.root)})
            while True:
                try:
                    item = q.get(timeout=15)
                except queue.Empty:
                    self._write_raw(b": ping\n\n")
                    continue
                self._write_sse(item["event"], item["data"])
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.hub.unsubscribe(q)

    def _write_sse(self, event: str, data: dict) -> None:
        chunk = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
        self._write_raw(chunk)

    def _write_raw(self, data: bytes) -> None:
        if not data:
            return
        self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    # ------------------------------------------------------------- oc proxy
    def _proxy(self, method: str, path: str, query: dict) -> None:
        if not self.oc.configured:
            return self._error(503, "no OpenCode service discovered; start it and reload")
        target = path
        if query:
            from urllib.parse import urlencode
            target += "?" + urlencode(query, doseq=True)
        body = self._read_body()
        content_type = self.headers.get("Content-Type")
        try:
            upstream = self.oc.open(method, target, body or None,
                                    content_type, timeout=3600)
        except urlerror.HTTPError as exc:
            data = exc.read()
            return self._send(exc.code, data,
                              exc.headers.get("Content-Type", "application/json"))
        except Exception as exc:  # noqa: BLE001
            return self._error(502, f"upstream error: {exc}")

        with upstream:
            status = upstream.status
            ctype = upstream.headers.get("Content-Type", "application/json")
            length = upstream.headers.get("Content-Length")
            streaming = "event-stream" in ctype or length is None
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            if not streaming:
                self.send_header("Content-Length", length)
                self.end_headers()
                while True:
                    chunk = upstream.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                self.wfile.flush()
                return
            # Unknown length or event stream: chunked transfer encoding.
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            # ``read(n)`` on a chunked response blocks until n bytes accumulate,
            # which never happens for an idle event stream. ``read1`` returns as
            # soon as any data is available.
            reader = getattr(upstream, "read1", None) or (lambda n: upstream.read(1))
            try:
                while True:
                    chunk = reader(65536)
                    if not chunk:
                        break
                    self._write_raw(chunk)
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            except Exception:  # noqa: BLE001 - stream died upstream; close cleanly
                pass

    # -------------------------------------------------------------- static
    def _serve_static(self, path: str) -> None:
        rel = unquote(path).lstrip("/") or "index.html"
        candidate = (APP_DIR / rel).resolve()
        if APP_DIR not in candidate.parents and candidate != APP_DIR:
            return self._error(403, "forbidden")
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.is_file():
            # SPA fallback
            candidate = APP_DIR / "index.html"
        ctype = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        body = candidate.read_bytes()
        self._send(200, body, ctype)


# --------------------------------------------------------------------------- #
# Server bootstrap
# --------------------------------------------------------------------------- #
class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, workspace: Workspace, hub: Hub,
                 oc: OpenCode, default_workspace: Path,
                 default_model: dict | None = None):
        super().__init__(addr, handler)
        self.workspace = workspace
        self.hub = hub
        self.oc = oc
        self.default_workspace = default_workspace
        self.default_model = default_model
        self.native_picker = detect_native_picker()
        self.validator = Validator(hub)
        self.watcher = Watcher(workspace, hub)


def build_server(host: str, port: int, workspace_dir: Path,
                 oc_url: str | None, model_spec: str | None = None) -> BridgeServer:
    discovery = discover_service()
    oc = OpenCode()
    oc.configure(discovery, oc_url)
    workspace = Workspace(workspace_dir)
    hub = Hub()
    server = BridgeServer((host, port), Handler, workspace, hub, oc, workspace_dir,
                          parse_model_ref(model_spec))
    return server


def find_free_port(host: str, preferred: int) -> int:
    for port in range(preferred, preferred + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port found")


def write_registration(server, workspace: str | None = None) -> None:
    """Publish where this bridge is listening so the OpenCode plugin can find it.

    Several bridges can run at once (a second one on another port, a test
    instance, …). Each always records itself as ``bridge-<port>.json``, but only
    claims the primary ``bridge.json`` if it is the default port or the current
    owner is gone — otherwise a scratch instance would silently hijack the
    plugin's target.
    """
    host, port = server.server_address[0], server.server_address[1]
    payload = {
        "url": f"http://{host}:{port}",
        "host": host,
        "port": port,
        "pid": os.getpid(),
        "version": VERSION,
        "workspace": workspace or str(server.workspace.root),
        "started": time.time(),
    }
    try:
        state_dir().mkdir(parents=True, exist_ok=True)
        registration_path(port).write_text(json.dumps(payload, indent=1))
        primary = registration_path()
        owner = read_json_file(primary)
        may_claim = (port == DEFAULT_PORT or not owner
                     or not pid_alive(owner.get("pid")))
        if may_claim:
            primary.write_text(json.dumps(payload, indent=1))
    except OSError:
        pass


def clear_registration(port: int | None = None) -> None:
    for path in (registration_path(port), registration_path()):
        if path is None:
            continue
        data = read_json_file(path)
        if data.get("pid") == os.getpid():
            try:
                path.unlink()
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="opencode-mermaid local bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--workspace", default=None,
                        help="workspace directory (default: ./graphs or cwd)")
    parser.add_argument("--oc-url", default=None, help="OpenCode server URL override")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"default chat model as provider/model#variant (default: {DEFAULT_MODEL})")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    if args.workspace:
        workspace_dir = Path(args.workspace).expanduser().resolve()
    else:
        graphs = REPO_ROOT / "graphs"
        workspace_dir = graphs if graphs.is_dir() else Path.cwd()
    if not workspace_dir.is_dir():
        workspace_dir.mkdir(parents=True, exist_ok=True)

    port = find_free_port(args.host, args.port)
    server = build_server(args.host, port, workspace_dir, args.oc_url, args.model)
    server.watcher.start()
    write_registration(server)

    url = f"http://{args.host}:{port}/"
    oc_state = "connected" if server.oc.configured else "not discovered"
    print(f"opencode-mermaid {VERSION}")
    print(f"  editor    {url}")
    print(f"  workspace {workspace_dir}")
    print(f"  opencode  {oc_state} ({server.oc.url or 'n/a'})")
    print(f"  plugin    {registration_path()}")
    print("  press Ctrl+C to stop")

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        server.watcher.stop()
        clear_registration(port)
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
