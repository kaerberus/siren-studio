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
| GET | `/api/fs/dirs?path=` | browse directories for the workspace picker |
| POST | `/api/fs/mkdir` | create a folder |
| POST | `/api/pick-directory` | the desktop's own folder chooser |
| POST | `/api/validate` | structural lint, upgraded to a real Mermaid parse when an editor is connected |
| POST | `/api/validate-result` | the editor's answer to a validate request |
| * | `/oc/api/...` | reverse proxy to OpenCode (streams SSE) |

## The plugin and the validation round-trip

`agent/plugins/graph-tools.js` runs inside OpenCode and talks HTTP to the same
bridge the editor uses. It exposes exactly two tools — `graph_validate` and
`graph_focus` — because those are the only two the built-in catalogue cannot do.
`graph_list` / `graph_read` / `graph_write` were removed: they wrapped `glob`,
`read` and `write`, added context noise to every agent, and `graph_write` wrote
files over HTTP, which bypasses the `edit` permission rules entirely.

```
agent → graph_validate ─┐
                        ▼
        bridge POST /api/validate
          ├─ lint_mermaid(source)         ← always (Python, no JS needed)
          └─ if an editor is subscribed:
               Hub.publish("validate-request", {nonce, source})
               … editor runs mermaid.parse …
               editor POST /api/validate-result {nonce, ok, errors}
               Validator.resolve(nonce) → the real verdict wins
```

The bridge owns no JavaScript runtime, so it borrows the browser's Mermaid for
authoritative parsing and falls back to the structural linter when the editor is
closed or slow (4s). `Validator` waits on a `threading.Event` keyed by a nonce;
`ThreadingHTTPServer` keeps the rest of the bridge responsive meanwhile.

The bridge also advertises itself for the plugin:

- `~/.local/state/opencode-mermaid/bridge.json` — the primary pointer
- `~/.local/state/opencode-mermaid/bridge-<port>.json` — every instance

Only the default port (or a bridge replacing a dead owner) may claim the primary
pointer, so a second bridge on another port cannot silently become the plugin's
target. Discovery order in the plugin: `options.url` → `$MERMAID_STUDIO_URL` →
primary pointer → `http://127.0.0.1:8777`.

A local plugin file has no `node_modules`, so it must not import
`@opencode/plugin`; OpenCode only requires the default export to be an object
with an `id` and a `setup` (or `effect`) function. Local plugin files are cached
in the running server, so the first load needs `opencode service restart`.

## Who may touch the graph

Two layers, because tools and permissions are global while the intent is not.

```
plugin registers graph_*   → shared tool catalogue (every agent sees them)
global opencode.jsonc      → { graph_* : deny }           (default off)
graph-engineer frontmatter → { edit * : deny
                               edit *.mmd, *.gaps.md : allow
                               shell * : deny
                               graph_validate, graph_focus : allow }
```

Agent rules are appended after global rules and the last match wins, which is why
the agent's `allow` beats the global `deny`, and why `edit *.mmd` beats `edit *`.

**Extensions, not directories.** The editor's workspace is normally the diagrams
directory, so paths relative to the Location are bare filenames and a `graphs/*`
rule silently matches nothing. Extension rules are location-independent. (The
matcher's `*` already spans `/`, so `*.mmd` covers nested paths too — writing
`graphs/**` would be a mistake.)

**`shell` must be denied too**, or the `edit` deny is meaningless: shell runs
with the host user's full filesystem authority.

Verified empirically (see the harness): the deny *removes* the tool from the
agent's catalogue rather than merely blocking calls, so `build` reports no graph
tools at all and `graph-engineer` reports no shell tool. The plugin also
self-gates on the calling agent id when the runtime supplies it, as
belt-and-braces.

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
