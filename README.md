# Siren Studio

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

# open a specific project
python3 start.py --project ~/code/my-project

# ignore the last project and open this checkout
python3 start.py --checkout
```

The editor opens on a **project root**, and diagrams live in a directory inside
it (default `graphs/`). The project root is the OpenCode session Location, so
diagram paths read as `graphs/03-payment.mmd` for you and for the agent.

With no arguments, `start.py` reopens **the last project you used** and falls back
to this checkout the first time (or if that project is gone). It names the project
it picked, and where it got it from, in the startup banner; `--checkout` forces
this repo. The project name is also echoed in the topbar, the file-tree head and
the browser tab, so which folder you are on is never a guess.

Requires the OpenCode service to be running (it normally is while OpenCode is
open: `opencode service status`).

## Editor

- **Split view** — CodeMirror editor with Mermaid syntax highlighting, bracket
  matching and inline lint errors, next to a live Mermaid preview. Both dividers
  drag: editor↔preview, and preview↔Graph Engineer panel. `Ctrl+B` collapses the
  panel.
- **Viewer** — auto-centres and fits the graph on open; wheel to zoom, drag to
  pan, Fit to reset. Zoom/pan is done by driving the SVG `viewBox`, so it stays
  vector-crisp at any magnification. Full-screen present mode, export to
  SVG / PNG / `.mmd`, copy source.
  PNG export re-renders the diagram with text labels and no `<foreignObject>`
  (browsers refuse to rasterise those inside an `<img>`), and reports a clear
  error if the browser can't produce the image.
- **Optimize fit for viewport** (the checkbox next to the zoom controls, on by
  default) lays a flowchart out on the other axis when that uses the pane
  better. A wide `LR` graph in a tall preview pane otherwise fits by width and
  leaves most of the height empty; optimize fit draws it as `TD` instead. It
  only acts when the fitted graph would use **less than 45%** of the pane on its
  non-binding axis *and* the graph's direction disagrees with the pane's shape,
  so it can't oscillate. **Flowcharts only** — sequence, state, pie and ER
  diagrams have no direction to flip.
  Its lamp says what it is doing: **green** while it is on, **amber** when the
  current diagram would transpose but the feature is off, and neutral when there
  is nothing to do. It is a *view*: the file is untouched, the header shows
  *transposed to fit* while flipped, and you can uncheck it to see the graph as
  authored. Exports follow what is on screen. It re-decides when the pane is
  resized or either splitter is dragged.
- **Selection sync** — hover a node in the preview and its source lines light up;
  click an outline entry to jump to its definition; click an ordinary node to
  jump to it in the editor.
- **Cross-file links** — a node that hands off to another diagram links with
  Mermaid's own `click` directive:
  `click Payment "03-payment.mmd" "Open the payment detail"`. Clicking the node
  opens that file in a tab instead of navigating the browser, and the node is
  drawn as a link — accent colour, underlined, pointer — so the hand-off is
  visible rather than something you have to know. Targeting is by node **id**, so
  node labels stay free for prose. The target is a filename in the diagrams
  directory or a path from the project root; a bare filename resolves anywhere in
  the directory, preferring a sibling of the open diagram. A link to a file that
  is not there stays a plain node, so a diagram the agent has not written yet does
  not look clickable.
- **Panels** — Files, Outline (nodes + subgraphs), and **Gaps**, which renders
  the diagram's `*.gaps.md` design-gap ledger.
- **Tabs, autosave, live reload** — when the agent rewrites a file the editor
  picks it up; if you have unsaved edits you get a reload / keep-mine choice.
- **Rescan folder** — the circular-arrow button next to the file-tree head
  re-reads the tree, every clean buffer, and the open diagram's ledger, then
  says what changed. Dirty buffers are left alone. It deliberately does *not*
  switch project — that is *Open project…* at the foot of the sidebar. The head
  itself names the folder you are on (`project/graphs`), with the absolute path
  on hover.
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
| `Enter` | Send a chat message, or steer a running one (`Shift+Enter` for a new line) |

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

One concern per graph: when a flowchart starts answering two questions the agent
splits it into `NN-topic.mmd` and leaves a `click`-linked node behind in the parent
— which is what the cross-file links above are for. `graph_validate` nudges it past
~25 nodes and flags a link whose file does not exist.

It is pinned to `deepseek/deepseek-flash` via the `model:` field in its
frontmatter; remove that line to let it inherit whatever OpenCode is set to.
The editor's model picker can override it per session.

### Permissions: diagrams only, and no shell or prompt tool

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
  - action: question
    resource: "*"
    effect: deny            # the editor has no picker for it, so a turn that
                            # calls it would block forever
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

`question` is an OpenCode built-in that blocks until you answer a
multiple-choice picker. The editor has no picker, so a turn that calls it waits
on an answer that can never arrive — the tool is denied per-agent rather than
globally, so the TUI keeps it. The prose "open questions with a default" list is
the replacement, and it is what the agent would have produced anyway.

This is guardrails, not a sandbox. It stops the agent *accidentally* changing
your code. It is not a jail against a hostile agent.

### Using it from the editor

Open the chat panel (`Ctrl+B`), tick "attach current diagram" / "attach gap
ledger", and ask. Quick prompts cover *Model codebase*, *Find gaps*, *Simplify*,
and *Add error paths*. Mermaid blocks in its replies get an **Apply to editor**
button.

**Model picker.** The pill in the top bar — `● OpenCode 2.0.11 · DeepSeek V4.1
Flash` — is a button. Clicking it opens a searchable palette of every model
OpenCode is configured with, grouped by provider and including effort variants
and a price hint (`free`, or `$in / $out` per million tokens). Type to filter,
`↑↓` to move, `Enter` to pick. It works for anything OpenCode can reach, so a
local Ollama endpoint shows up alongside cloud models.

There is also a plain dropdown in the panel header for quick switching. Both are
wired to one setter, so they cannot drift. The default is
`deepseek/deepseek-flash` (`--model provider/model#variant`, default effort
level) and your choice is remembered. Free models on OpenCode Zen are
intermittently flaky — if a turn produces nothing, see below.

**Sessions.** The editor reuses one session per workspace rather than creating a
new one on every page load. **New session** in the panel header starts a fresh
conversation (titled after the open diagram); the status line shows the model
and a short session id so you can tell them apart.

**Steering.** Send stays enabled while a turn runs: sending mid-turn steers it.
While the model is working the composer says so — the placeholder reads
*"Model is running — send a message to steer it…"* — which matters most when the
agent has asked you something, because your next message is the answer.

**Stuck turns are visible.** A turn where *nothing* changes for 45s — no text, no
reasoning, no tool activity — is reported with a
*"No output from `<model>` yet — Retry / Stop"* bar instead of spinning forever.
Thinking and running tools count as progress, so a long turn is not called stuck
while it is working, and a tool that is waiting on you is not either. A reply that
completes with nothing visible says so and offers Retry.

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
| `<root>/graphs/AGENTS.md` | when an agent first reads a file in `graphs/` | the diagram conventions — naming, ledger pairing, the split rule, and what makes a reference into a link |

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
├─ example-graphs/          example diagrams (reference; the editor's default is graphs/)
├─ agent/                   agent, skill and plugin sources
│  ├─ graph-engineer.md
│  ├─ global-permissions.json   graph_* denied to every agent by default
│  ├─ skills/graph-engineering/
│  └─ plugins/graph-tools.js
├─ tests/                   dev suites (Node + jsdom; see tests/README.md)
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
- **Binds to `127.0.0.1` only — that is load-bearing, not just a default.** The
  bridge has no authentication of its own, and two things sit behind the port:

  - `/api/fs/*` reads and writes anything under the workspace;
  - `/oc/*` proxies to OpenCode **with your credentials attached**, so whatever
    can reach the port can drive your agent as you.

  So any local process that reaches the port gets both, and exposing the port
  turns that into a remote filesystem-and-agent hole rather than a mere privacy
  leak. Keep it on loopback: do not bind to `0.0.0.0`, port-forward it, or put it
  behind a reverse proxy. To use it from another machine, tunnel the connection
  (`ssh -L 8777:127.0.0.1:8777 host`) instead of listening publicly.

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

It also reports what the source alone cannot show. These are **warnings, never
errors** — a diagram can be perfectly valid and still get one:

- **a link that goes nowhere** — a `click` naming a `*.mmd` that does not exist
  would be a dead end in the editor, which the agent cannot see from inside its
  own reasoning;
- **the size advisory** — past ~25 nodes or 5 subgraphs, a nudge to consider
  splitting instead of growing;
- **a missing ledger** — a diagram with no sibling `*.gaps.md`, checked when
  validating by path.

> **Loading the plugin for the first time requires `opencode service restart`.**
> Local plugin files are cached in the running process; after that one restart,
> subsequent edits are picked up normally.
>
> **Changing what an agent is *allowed to do* also needs a restart.** OpenCode
> re-reads an agent's prompt every turn, so editing the prose in
> `graph-engineer.md` takes effect immediately — but its permissions and tool
> list are snapshotted when the service starts. Add or remove a rule and restart,
> or the running service keeps serving the old tool surface.

## Tests

```sh
tests/bootstrap.sh    # once: fetch Node + jsdom if you don't already have them
tests/run.sh
```

Seven suites, ~250 checks. `run.sh` starts its own bridge on port 8788 against a
throwaway workspace, so your live editor and your real project are never touched.
They cover the editor (boot, tabs, preview, outline, the gap panel, chat
rendering, cross-file links, both splitters, the model palette, workspace labels
and rescan), the viewer's transposition decision across pane shapes, SVG/PNG
export against real Mermaid output, project setup, the launcher's project
memory and awareness wiring, the plugin's bridge API, a live agent round-trip,
and the permission model end to end. See `tests/README.md`.

## Status / roadmap

Implemented: everything above, including the plugin.

Ideas not built: a **child viewport** — showing a referenced diagram beside its
parent rather than in a tab, for which the clickable references were the cheap way
to find out whether it earns the refactor — plus per-tab viewport memory, a
diagram diff/checkpoint, and `graph_render` (server-side PNG via a headless
renderer).
