# TODO — next steps and handoff

Written 2026-09-28 to survive a context compaction. Read `README.md` and
`docs/architecture.md` first; this file only holds what they don't.

## Running it

```sh
python3 install-agent.py          # agent + skill + plugin into ~/.config/opencode
python3 start.py                  # defaults to this checkout
python3 start.py --project ~/code/some-project
```

- Editor: <http://127.0.0.1:8777/>. The bridge must be running; OpenCode must be
  running for the chat to work.
- `opencode service restart` is required after **plugin** changes (local plugin
  files are cached in the running server). Agents and skills reload automatically.
- If the bridge was started from inside an agent's shell, restarting the OpenCode
  service kills it. Starting it from your own terminal survives that.

## Dev test suites — currently in /tmp, which is volatile

`/tmp/opencode/harness` (node 22 tarball + jsdom installed there):

| suite | covers |
| --- | --- |
| `smoke.mjs` | editor boot, tabs, preview, outline, chat render, model palette, smart view, missing-agent handling (91 checks) |
| `smart-view.mjs` | transposition decision across pane shapes |
| `export-e2e.mjs` | rasterisable SVG against real Mermaid |
| `chat-e2e.mjs` | live agent round-trip through the app module |
| `project-setup.py` | project/diagrams detection guards, awareness wiring |
| `plugin-bridge.py` | the plugin's bridge API + validation round-trip |
| `permissions-e2e.py` | graph-only writes, no shell, tool scoping |

They run against an isolated bridge on **port 8788** (`--project
/tmp/opencode/smoke-workspace`), so they don't depend on which project the live
editor is pointed at.

**Item 6 below is to move these into the repo** before /tmp is cleared.

## The work

### 1. Agent brevity — the biggest win

`agent/graph-engineer.md` → `# Output discipline` currently *mandates* long
replies: every response must contain a full ```mermaid block, a "Modelling
notes" section, and an "Open questions" list. That is why a one-line question
gets a wall of text.

Replace with rules along these lines (keep "Open questions" — it is load-bearing
for the gap loop — but stop it restating the ledger):

- Answer the question first, in a few sentences.
- Include a ```mermaid block **only when the diagram changed**.
- If it changed, say what changed in one line; don't restate the whole diagram.
- Never quote the diagram or ledger back — reference them by file.
- Modelling notes: at most 3 bullets, only if they carry a decision.
- Open questions: only those gating the next step, one line each with a default.

### 2. Collapse attachments in the chat transcript

`buildPrompt` (`app/js/agent.js`) inlines the diagram and ledger as text, so the
user's own message bubble contains two whole files, and the agent tends to quote
them back.

Render-only fix: split the user message on the `Current diagram (…)` /
`Current gap ledger (…)` markers, show the user's actual question, and fold the
rest into a collapsed `<details>` reading *"attached: a.mmd, a.gaps.md"*. The
model still receives exactly what it does today (including unsaved buffer edits —
which is why we inline rather than use file attachments).

Export the markers from one place so `buildPrompt` and the renderer can't drift.

### 3. Resizeable agent panel

`--agent-w` is fixed at 370px and the only splitter is editor↔viewer. Add a
second drag handle before the agent panel, adjust `--agent-w` with min/max
clamps, hide it when the panel is collapsed.

### 4. Conventions wording

Two places say something ambiguous:

- generated `graphs/AGENTS.md` (`conventions_block` in `bridge/server.py`):
  *"Keep a diagram under about 20 nodes; split rather than sprawl."*
- `agent/skills/graph-engineering/references/diagram-selection.md` (which is
  clearer — it says extract a subflow into its own `.mmd`).

"Split" means **separate files**, not subgraphs. And 20 nodes is an arbitrary
count standing in for a readability condition. Reword to something like: *if you
can't read it without panning or zooming, split it into `NN-topic.mmd` files.*
Note this changes the generated text, so re-running the wire-up is needed.

### 5. Clickable `.mmd` references + a child viewport

**Goal.** Following a graph-of-graphs by hand is the missing navigation.
`Sub[[see 03-payment.mmd]]` is currently decorative — Mermaid has no cross-file
link, and clicking a node just jumps the editor to its source line.

**Design decisions taken (after review):**

- **One inset pane, not many.** The viewer is a singleton (one `stage`, one
  `base`/`view`, module-level). One child pane with a breadcrumb and a back stack
  gives "parent and child visible together" without refactoring the viewer into
  instances, and removes the need for tiling, counts and recursion guards.
- **Auto-open yes, auto-close no.** Dismissal is user-owned. Closing something
  the user is mid-read on is hostile; "the next agent action didn't touch it" is
  also hard to define (a tool call? a turn? a write?).
- **Prefer the explicit signal.** `graph_focus` already means "show the user this
  diagram" — drive opening from that and from the user's clicks. Use file-change
  events only to *highlight* ("this changed"), not to open.
- **Guard the obvious edges:** don't open a file already in the stack (cycles);
  a reference to a file that doesn't exist yet shows as not-clickable (the agent
  may write it later); open as a tab instead if the pane is too narrow for an
  inset.
- **Discoverability:** a node is only clickable if its label resolves to a
  `.mmd`/`.mermaid` file in the diagrams directory — cursor + a small marker so
  it isn't hidden.

**Sketch.** After render, scan `g.node` labels for a diagram filename, resolve
it relative to the diagrams directory, and mark those nodes. Click opens the
referenced file in the child pane (else falls back to today's jump-to-source).
The child pane needs its own render target and its own `base`/`view`, so factor
the viewer's per-viewport state rather than duplicating the module-level globals.

### 6. Move the test suites into the repo

`/tmp/opencode/harness` is volatile. Move to `tests/` with a short README, and
add the vendored node/jsdom setup or document how to fetch it. These suites have
caught real bugs (stale agent list, the 45% oscillation trap, the
`graphs/*` permission rule never matching, PNG `foreignObject`).

## Notes that are easy to forget

- Session reuse: the editor attaches to the **newest** `graph-engineer` session
  whose `location.directory` exactly equals the project root. Exact matching is
  deliberate — a session's Location governs the agent's paths and its `*.mmd`
  write permission.
- Any session created before the project-root change (when the workspace *was*
  `graphs/`) is orphaned and will not be reused. Use `opencode --continue` or
  `opencode -s <id>` to reach an old one.
- A missing agent fails **closed**: `POST /api/session` accepts an unknown agent
  id, the turn then fails asynchronously as `Session.AgentNotFoundError`, and no
  permissions are ever computed. The editor now checks the agent list first and
  blocks with a clear message.
- The bridge remembers each project's diagrams directory in
  `~/.local/state/opencode-mermaid/projects.json` (an empty directory can't be
  detected).
- `AGENTS.md` in this repo was unwired and deleted on purpose: it was the
  dogfooding instance of the generator and carried no other content.
