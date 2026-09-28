# Mermaid Studio

A local, web-based Mermaid editor with a live graph viewer and an **OpenCode
"Graph Engineer" agent** you talk to from the editor, to model systems and hunt
down design gaps.

The graph is **design intent**. You and the agent agree it in the editor; code is
written against it; the agent updates it deliberately, with your approval, when
reality drifts.

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
live-reloads. The editor is the only surface for graph work — the graph is a
visual artifact and the loop is *look → point → adjust*.

## Quick start

```sh
# 1. install the Graph Engineer agent + skill globally
python3 install-agent.py

# 2. start the editor (opens your browser)
python3 start.py

# point it at a project instead of this checkout
python3 start.py --project ~/code/my-project
```

The editor opens on a **project root**, and diagrams live in a directory inside
it (default `graphs/`). The project root is the OpenCode session Location, so
diagram paths read as `graphs/03-payment.mmd` for you and for the agent.

Requires the OpenCode service to be running (it normally is while OpenCode is
open: `opencode service status`).

## Editor

- **Split view** — CodeMirror editor with Mermaid syntax highlighting, bracket
  matching and inline lint errors, next to a live Mermaid preview.
- **Viewer** — auto-centres and fits the graph on open; wheel to zoom, drag to
  pan, Fit to reset. Zoom/pan is done by driving the SVG `viewBox`, so it stays
  vector-crisp at any magnification. Full-screen present mode, export to
  SVG / PNG / `.mmd`, copy source.
  PNG export re-renders the diagram with text labels and no `<foreignObject>`
  (browsers refuse to rasterise those inside an `<img>`), and reports a clear
  error if the browser can't produce the image.
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
`agent/`). It is a global agent — it has to be, so it is available whichever
project you point the editor at — and that means it also *appears* in the TUI.
Ignore that. It is built for the editor; there is no useful way to hold a
conversation about a diagram you cannot see.

The agent follows a fixed method: recon → choose diagram type → draft with a
consistent visual vocabulary → validate → **gap analysis** → present gaps as
questions with recommended defaults. It keeps a `*.gaps.md` ledger beside each
diagram and cites `path:line` for claims about real code.

It is pinned to `deepseek/deepseek-flash` via the `model:` field in its
frontmatter; remove that line to let it inherit whatever OpenCode is set to.
The editor's model picker can override it per session.

### Permissions: graphs only, and no shell

`graph-engineer` can write diagrams and nothing else. In its frontmatter:

```yaml
permissions:
  - action: edit
    resource: "*"
    effect: deny            # never touch code
  - action: edit
    resource: "*.mmd"       # diagrams only, by extension
    effect: allow
  - action: edit
    resource: "*.gaps.md"   # and their ledgers
    effect: allow
  - action: shell
    resource: "*"
    effect: deny            # shell has full filesystem authority; denying
                            # `edit` alone would be theatre
```

Why **by extension, not by directory?** Because the editor's workspace is usually
the diagrams directory itself, so paths relative to the OpenCode Location are
bare filenames — `graphs/*` would never match and the agent could write nothing.
Extension rules work wherever the diagrams live.

`edit` covers `edit`, `write` and `patch`, and the matcher's `*` already spans
`/`, so `*.mmd` also matches `graphs/nested/thing.mmd`. Agent rules are appended
after global rules and the last match wins, which is why the `allow` beats the
`deny`. If you keep diagrams in `.md` files, add a rule for that extension
yourself — `*.md` is deliberately not allowed, since it would also permit editing
`README.md` and `AGENTS.md`.

This is guardrails, not a sandbox. It stops the agent *accidentally* changing
your code. It is not a jail against a hostile agent.

### Using it from the editor

Open the chat panel (`Ctrl+B`), tick "attach current diagram" / "attach gap
ledger", and ask. Quick prompts cover *Model codebase*, *Find gaps*, *Simplify*,
and *Add error paths*. Mermaid blocks in its replies get an **Apply to editor**
button.

**Model picker.** The panel header shows which model is answering. It defaults
to `deepseek/deepseek-flash` (set with `--model provider/model#variant`, default
effort level) and lists every model OpenCode offers, grouped by provider, with
effort variants. Your choice is remembered and applied to the session
immediately. Free models on OpenCode Zen are intermittently flaky — if a turn
produces nothing, see below.

**Sessions.** The editor reuses one session per workspace rather than creating a
new one on every page load. **New session** in the panel header starts a fresh
conversation (titled after the open diagram); the status line shows the model
and a short session id so you can tell them apart.

**Stuck turns are visible.** A turn that produces no output for 45s is reported
with a *"No output from `<model>` yet — Retry / Stop"* bar instead of spinning
forever, and a reply that completes with no content says so and offers Retry.

### The skill

`agent/skills/graph-engineering/` is installed alongside and referenced by the
agent:

- `diagram-selection.md` — which diagram answers which question
- `mermaid-syntax.md` — syntax that reliably parses, plus failure modes
- `vocabulary.md` — the shape/colour palette and layout rules
- `gap-checklist.md` — the systematic gap taxonomy
- `codebase-to-flow.md` — extracting flows from source
- `ledger-template.md` — the gap-ledger format

## Making the graph inform development

Nothing about the graph reaches your coding agents until something tells them it
exists. The mechanism is a project `AGENTS.md` — V2 recognises that file only, the
`instructions` config array is not resolved in V2, and `references` is for
directories outside the project. So it has to be a file in the repo.

**The editor writes it for you.** Two places:

- **When you pick a project** — the picker has a *Set up for diagrams* checkbox,
  ticked by default for a fresh folder and unticked for a project that already
  has an `AGENTS.md`. Picking the folder then creates the diagrams directory if
  needed and wires the awareness in the same gesture.
- **The sidebar button** — `Make agents aware` / `Agents aware ✓`. Clicking it
  shows the project, the files and the exact block before you commit, with
  **Update** and **Unwire**.

It writes two things:

| file | when it loads | contents |
| --- | --- | --- |
| `<root>/AGENTS.md` | before the agent starts | a few lines: read the diagram before implementing a flow, never edit `graphs/`, say so when code diverges, and a pointer to the nested file |
| `<root>/graphs/AGENTS.md` | when an agent first reads a file in `graphs/` | the diagram conventions — naming, ledger pairing, size limits |

That split is the closest thing to conditionality the mechanism offers. You
cannot branch on *which agent* is running — the root file is injected into every
session in that project. You branch on *what the agent is doing*: everybody gets
the short pointer, and only agents that actually open a diagram get the detail.

### How the files are managed

Both files are wrapped in `<!-- graph-awareness:start -->` / `<!-- graph-awareness:end -->`
comments. The tool only ever replaces what is between them, so your own text
survives — and re-running is safe: no duplicate blocks, and the paths inside
refresh if you move the diagrams directory. **Unwire** deletes just that block.

### Choosing the diagrams directory

Detection runs first, and it guards against the obvious ways to get it wrong:

1. a directory this project used before, if it still exists;
2. an existing `graphs/`;
3. diagrams at the project root — so pointing the editor at your existing
   diagrams folder never creates `graphs/graphs/`;
4. diagrams already somewhere else (say `docs/flows/`) — adopted, not shadowed.

Only if none of those apply is `graphs/` created. A project's diagrams directory
is remembered, so a project you set up before drawing anything keeps its choice
instead of getting a competing default later.

That is the whole "seeding" step: point `plan` or `build` at a well-designed
graph and let the diagram be the spec. There is no code generation from graphs,
and there shouldn't be — graphs are coarse, and codegen from a coarse model gets
ugly fast.

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
├─ agent/                   agent, skill and plugin sources
│  ├─ graph-engineer.md
│  ├─ global-permissions.json   graph_* denied to every agent by default
│  ├─ skills/graph-engineering/
│  └─ plugins/graph-tools.js
├─ AGENTS.md                generator-managed graph awareness (this repo)
├─ graphs/AGENTS.md         generator-managed diagram conventions
└─ docs/architecture.md
```

## How the bridge works

- **Service discovery** — reads `~/.local/state/opencode/service.json`
  (`url`, `pid`, `password`) and authenticates with basic auth. Override with
  `--oc-url`.
- **Proxy** — everything under `/oc/*` is forwarded to the OpenCode API,
  including the `/api/event` SSE stream (browsers can't set auth headers on
  `EventSource`, so the bridge adds them).
- **Filesystem** — `/api/fs/*` is rooted at the project root and scoped to the
  diagrams directory; writes are atomic and broadcast as `file-changed` events
  tagged `editor` or `external`.
- **Project memory** — the chosen diagrams directory per project is kept in
  `~/.local/state/opencode-mermaid/projects.json`, because a directory that is
  still empty cannot be detected by looking at its contents.
- **Binds to `127.0.0.1` only.** It is a single-user local tool: any local
  process that can reach the port can read and write the workspace.

## OpenCode plugin: two tools

`agent/plugins/graph-tools.js` adds exactly two tools, and only because the
built-ins genuinely cannot do them:

| tool | what it does | why not a built-in |
| --- | --- | --- |
| `graph_validate` | structural lint, upgraded to the **real Mermaid parser** when the editor is open | `read` sees the source but nothing built in can tell you whether it parses |
| `graph_focus` | ask the editor to open a diagram and bring it forward | nothing built in can drive the editor's UI |

In Code Mode they appear as `tools.graph.validate(...)` and
`tools.graph.focus(...)`.

**What is deliberately *not* there.** Earlier versions also shipped `graph_list`,
`graph_read` and `graph_write`. They were wrappers over `glob`, `read` and
`write`, and because plugin tools land in the shared catalogue with every
agent's default policy of `allow *`, they added noise to `build`, `plan` and
`explore` too. `graph_write` was worse than noise: it wrote files over HTTP,
bypassing the `edit` permission rules. Use the built-ins — the editor's file
watcher reloads on any write.

**Only the graph agents may call them.** A global rule in
`~/.config/opencode/opencode.jsonc` denies `graph_*` to everyone:

```jsonc
{ "permissions": [{ "action": "graph_*", "resource": "*", "effect": "deny" }] }
```

The `graph-engineer` frontmatter re-allows them for itself. Agent rules are
appended last, so the later `allow` wins. `install-agent.py` creates that global
file if absent, and prints the rule to merge if you already have one, rather than
clobbering your config. The tools also self-gate on the calling agent when the
runtime reports it, as a belt-and-braces fallback.

**How it finds the editor.** The bridge writes
`~/.local/state/opencode-mermaid/bridge.json` on startup (plus a per-port
`bridge-<port>.json`). The plugin reads the primary pointer; override with the
`url` plugin option or `$MERMAID_STUDIO_URL`. If several bridges run, only the
default port — or a bridge replacing a dead owner — claims the primary pointer,
so a scratch instance cannot hijack it.

**Validation round-trip.** `graph_validate` always runs the bridge's structural
linter (missing diagram keyword, unbalanced brackets, unclosed quotes, reserved
ids, stray `end`, unquoted `; # %`). When an editor is connected, the bridge
also asks it over SSE to parse with Mermaid itself and that verdict wins — so
the agent gets a real answer, with line numbers, without the bridge needing a
JavaScript runtime.

> **Loading the plugin for the first time requires `opencode service restart`.**
> OpenCode re-reads agents and skills on reload, but local plugin files are
> cached in the running process. After that one restart, subsequent edits are
> picked up normally.

## Status / roadmap

Implemented: everything above, including the plugin.

Ideas not built: per-tab viewport memory, a diagram diff/checkpoint, and
`graph_render` (server-side PNG via a headless renderer).
