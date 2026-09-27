# Architecture

## Process model

Two processes, one shared filesystem.

1. **The bridge** (`bridge/server.py`) — Python standard library only.
   `ThreadingHTTPServer` on `127.0.0.1`. It serves `app/`, proxies OpenCode, and
   exposes a workspace filesystem API plus an SSE event stream.
2. **OpenCode** — an already-running service. The bridge discovers it and
   forwards authenticated requests to it. The Graph Engineer agent runs here.

The browser never talks to OpenCode directly. That keeps authentication on the
server side (the browser cannot set `Authorization` on `EventSource`) and avoids
depending on OpenCode's CORS behaviour.

## Data flow: agent → editor

```
agent (write tool) ──► graphs/foo.mmd ──► Watcher (1s poll)
                                            │  mtime changed, origin=external
                                            ▼
                                      Hub.publish("file-changed")
                                            │  SSE
                                            ▼
                                   editor reloads the open tab
```

If the editor itself wrote the file, it records the resulting mtime so the
watcher can label the event `origin=editor` and the editor ignores its own echo.

## Data flow: editor → agent

```
composer ──► POST /oc/api/session/{id}/prompt  (text + diagram + ledger inlined)
                │
                ▼
        OpenCode session (agent=graph-engineer, location=workspace)
                │
   GET /oc/api/event  (SSE, proxied)  ──► debounced refresh
                │
   GET /oc/api/session/{id}/context    ──► rendered into the chat log
```

Attachments are inlined into the prompt text rather than sent as file URIs, so
the agent sees exactly what is on screen, including unsaved edits.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` and `/...` | static app files |
| GET | `/health` | bridge + OpenCode status |
| GET | `/api/config` | workspace, OpenCode status, agent list, default model |
| GET | `/api/fs/tree` | workspace tree |
| GET | `/api/fs/file?path=` | read a file |
| PUT | `/api/fs/file` | write a file (broadcasts `file-changed`) |
| DELETE | `/api/fs/file?path=` | delete a file |
| POST | `/api/fs/move` | rename/move |
| POST | `/api/workspace` | switch workspace (resets the watcher baseline) |
| GET | `/api/events` | SSE: `ready`, `file-changed`, `file-created`, `file-deleted`, `workspace-changed`, `focus` |
| POST | `/api/focus` | broadcast a focus request to the editor |
| POST | `/api/open` | open a path in the OS file manager |
| * | `/oc/api/...` | reverse proxy to OpenCode (streams SSE) |

## Path safety

`Workspace.resolve()` rejects any path that escapes the workspace root after
symlink resolution. The server binds to loopback only. This is deliberate: it is
a local, single-user tool, not a hardened service.

## Frontend modules

| File | Responsibility |
| --- | --- |
| `bridge.js` | fetch helpers for the bridge and the proxied OpenCode API |
| `editor.js` | CodeMirror 5 setup, a custom Mermaid simple-mode, lint wiring |
| `viewer.js` | Mermaid render, pan/zoom, node highlighting, SVG/PNG export |
| `agent.js` | OpenCode session lifecycle and reuse, model selection, prompt building, message parsing, stall/empty-turn detection |
| `app.js` | state, file tree, tabs, autosave, live reload, outline, gaps, chat |

## Why CodeMirror 5 and a vendored Mermaid UMD

There is no Node runtime on the target machine. CodeMirror 6 is a graph of ES
modules with shared singletons that cannot be reliably vendored without a
bundler; CodeMirror 5 ships as a single global script plus small addons.
Mermaid's `dist/mermaid.min.js` UMD is fully self-contained, whereas the ESM
build lazy-loads hashed chunk files. Both are pinned and committed so the editor
works offline.

## Known limitations

- Sessions are location-scoped: switching workspace starts a new agent session.
- The outline/selection mapping is regex-based (the CodeMirror simple mode has no
  AST). It handles the common node shapes and subgraphs; exotic syntax may be
  missed.
- The bridge trusts anything that can reach loopback.
