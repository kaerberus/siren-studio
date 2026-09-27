# Mermaid Studio

A local, web-based Mermaid editor with a live graph viewer and an **OpenCode
"Graph Engineer" agent** you can talk to from either side — the editor's chat
panel or the OpenCode terminal — to model systems and hunt down design gaps.

No Node, no bundler, no build step. Python 3 (stdlib only) serves the app and
bridges to the OpenCode API; Mermaid and CodeMirror are vendored so it works
offline.

```
┌──────────────── browser: app/ ─────────────────┐
│  code editor  │  live graph  │  Graph Engineer │
└───────────────────────┬─────────────────────────┘
                        │ same-origin
┌─────────────── bridge/server.py ────────────────┐
│  /        serve the editor                       │
│  /oc/*    reverse-proxy OpenCode (+auth, SSE)    │
│  /fs/*    read/list/write diagrams               │
│  /events  file-change + focus stream (SSE)       │
└───────────────────────┬─────────────────────────┘
                        │  the same files on disk
                        ▼
        opencode agent "graph-engineer"  →  *.mmd + *.gaps.md
```

The diagram files are the shared state: the agent edits them, the editor
live-reloads. You can hone a graph from the terminal or the editor and see it in
both.

## Quick start

```sh
# 1. install the Graph Engineer agent + skill globally
python3 install-agent.py

# 2. start the editor (opens your browser)
python3 start.py

# point it at a project instead of the bundled examples
python3 start.py --workspace ~/code/my-project
```

Requires the OpenCode service to be running (it normally is while OpenCode is
open: `opencode service status`).

## Editor

- **Split view** — CodeMirror editor with Mermaid syntax highlighting, bracket
  matching and inline lint errors, next to a live Mermaid preview.
- **Viewer** — wheel to zoom, drag to pan, fit-to-view, full-screen present mode,
  export to SVG / PNG / `.mmd`, copy source.
- **Selection sync** — hover a node in the preview and its source lines light up;
  click an outline entry to jump to its definition; click a node to jump to it.
- **Panels** — Files, Outline (nodes + subgraphs), and **Gaps**, which renders
  the diagram's `*.gaps.md` design-gap ledger.
- **Tabs, autosave, live reload** — when the agent rewrites a file the editor
  picks it up; if you have unsaved edits you get a reload / keep-mine choice.
- **Templates** — flowchart, error paths, state machine, sequence, codebase map,
  data model.
- **Dark and light** themes.

### Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl+S` | Save |
| `Ctrl+N` | New diagram |
| `Ctrl+B` | Toggle Graph Engineer panel |
| `Ctrl+1` | Toggle the files sidebar |
| `Ctrl+Enter` | Send a chat message |

## The Graph Engineer agent

Installed to `~/.config/opencode/agents/graph-engineer.md` (symlinked from
`agent/`), so it is available in every project. It is a `mode: all` agent, so you
can select it as the primary agent in the TUI or launch it as a subagent.

The agent follows a fixed method: recon → choose diagram type → draft with a
consistent visual vocabulary → validate → **gap analysis** → present gaps as
questions with recommended defaults. It keeps a `*.gaps.md` ledger beside each
diagram and cites `path:line` for claims about real code.

### Using it from OpenCode

```sh
opencode --agent graph-engineer
# or from inside a session:
#   @graph-engineer model this codebase's request path
```

Ask it to model the project; it writes `.mmd` files; the editor live-reloads.

### Using it from the editor

Open the chat panel, tick "attach current diagram" / "attach gap ledger", and
ask. Quick prompts cover *Model codebase*, *Find gaps*, *Simplify*, and
*Add error paths*. Mermaid blocks in its replies get an **Apply to editor**
button.

### The skill

`agent/skills/graph-engineering/` is installed alongside and referenced by the
agent:

- `diagram-selection.md` — which diagram answers which question
- `mermaid-syntax.md` — syntax that reliably parses, plus failure modes
- `vocabulary.md` — the shape/colour palette and layout rules
- `gap-checklist.md` — the systematic gap taxonomy
- `codebase-to-flow.md` — extracting flows from source
- `ledger-template.md` — the gap-ledger format

## Layout

```
opencode-mermaid/
├─ start.py                 launcher (bridge + browser)
├─ install-agent.py         installs the agent + skill globally
├─ bridge/server.py         static server, OpenCode proxy, fs API, SSE
├─ app/                     the editor
│  ├─ index.html styles.css
│  ├─ js/  app.js editor.js viewer.js agent.js bridge.js
│  └─ vendor/               mermaid 11 + CodeMirror 5 (offline)
├─ graphs/                  default workspace (examples)
├─ agent/                   agent + skill sources
└─ docs/architecture.md
```

## How the bridge works

- **Service discovery** — reads `~/.local/state/opencode/service.json`
  (`url`, `pid`, `password`) and authenticates with basic auth. Override with
  `--oc-url`.
- **Proxy** — everything under `/oc/*` is forwarded to the OpenCode API,
  including the `/api/event` SSE stream (browsers can't set auth headers on
  `EventSource`, so the bridge adds them).
- **Filesystem** — `/api/fs/*` is scoped to the workspace; writes are atomic and
  broadcast as `file-changed` events tagged `editor` or `external`.
- **Binds to `127.0.0.1` only.** It is a single-user local tool: any local
  process that can reach the port can read and write the workspace.

## Status / roadmap

Implemented: everything above.

Phase 2 (not built yet): an OpenCode plugin
(`.opencode/plugins/graph-tools.ts`) adding `graph_list`, `graph_read`,
`graph_write`, `graph_validate` and `graph_focus` tools, so the agent can ask
the editor to open a specific diagram and validate against the real Mermaid
parser.
