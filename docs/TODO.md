# TODO — next steps and handoff

Written 2026-09-28 to survive a context compaction. Read `README.md` and
`docs/architecture.md` first; this file only holds what they don't.

**Status: the whole list below is agreed.** Order is the intended sequence.

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

## The work

### 1. ~~Move the dev test suites into the repo~~ — DONE

Now in `tests/`. `tests/bootstrap.sh` fetches Node + jsdom into `tests/.node`
and `tests/node_modules` (both gitignored); `tests/run.sh` starts an isolated
bridge on port 8788 against `/tmp/opencode/mermaid-tests/workspace`, runs all
seven suites (175 checks), and tears the bridge down.

Paths are derived from `import.meta.url` / `__file__`, and the bridge URL,
workspace and ports come from `TEST_PORT`, `TEST_WORKSPACE`, `TEST_BASE`,
`TEST_ROOT`. The old copy in `/tmp/opencode/harness` was deleted so there is
only one source of truth.

These suites caught the stale agent list, the 45% oscillation trap, the
`graphs/*` permission rule that never matched, and the PNG `foreignObject` bug.
They are the only guard against re-breaking those.

### 2. ~~Agent brevity~~ — DONE

`# Output discipline` no longer mandates a full ```mermaid block, a "Modelling
notes" section and an "Open questions" list on **every** reply. It now says:

- Lead with the answer; no preamble, no restating the request.
- Never quote the diagram or the ledger back — the editor renders them, so the
  chat is not a second copy. Reference them by file name.
- Show a ```mermaid block only when the diagram changed in this turn. If it did
  not change, a sentence is the whole reply.
- When it changed, say what changed in one line, and why.
- Modelling notes: at most 3 bullets, and only if they record a decision.
- Open questions: only those gating the next step, one line each with a default.
  If there are none, say so and name the strongest remaining assumption — do not
  restate the ledger and do not invent questions to fill the section.

The same mandate was **duplicated in two places the item did not mention**:
`# Workflow` step 6 ("Show the full diagram…"), and the skill — `SKILL.md` step 8
("Full diagram, modelling notes…") and its non-negotiable "Complete,
copy-pasteable ```mermaid blocks". Both rewritten; the skill's line is now a
*syntax* rule (when you do show source, never a fragment) rather than a
paste-every-turn rule.

Also fixed two `~20 nodes` copies that item 5 missed: `graph-engineer.md` →
Workspace conventions, and `codebase-to-flow.md` → "Calibrate altitude". Both
now state the concern test and mention the `graph_validate` advisory instead of
a hard node count.

Verified against the live model (`deepseek-flash`), fresh session:

| turn | reply |
| --- | --- |
| no diagram change ("what is a design gap?") | 246 chars, 1 line, no block, no sections |
| diagram changed (rename a decision label) | 766 chars: one-line summary, the block, 2 notes, 1 gated question with a default |

The agent is installed by symlink, so this is live without re-running
`install-agent.py`.

### 3. Collapse attachments in the chat transcript

`buildPrompt` (`app/js/agent.js`) inlines the diagram and ledger as text, so the
user's own message bubble contains two whole files, and the agent tends to quote
them back.

Render-only fix: split the user message on the `Current diagram (…)` /
`Current gap ledger (…)` markers, show the user's actual question, and fold the
rest into a collapsed `<details>` reading *"attached: a.mmd, a.gaps.md"*. The
model still receives exactly what it does today (including unsaved buffer edits —
which is why we inline rather than use file attachments).

Export the markers from one place so `buildPrompt` and the renderer can't drift.

### 4. Resizeable agent panel

`--agent-w` is fixed at 370px and the only splitter is editor↔viewer. Add a
second drag handle before the agent panel, adjust `--agent-w` with min/max
clamps, hide it when the panel is collapsed.

### 5. Conventions wording + a size advisory

Two audiences, deliberately separated.

**Prose = the principle, checkable by reasoning.** The generated
`graphs/AGENTS.md` (`conventions_block` in `bridge/server.py`) currently says
*"Keep a diagram under about 20 nodes; split rather than sprawl."* — which is
both ambiguous and **not actionable by an agent**, because an agent reads source,
never rendered pixels. It cannot know whether a reader would have to pan.

Replace with the concern test, and keep the pan/zoom line only as *rationale*
(agents follow a rule better with a stated reason):

```md
- One concern per graph. If you cannot state what it answers in one sentence,
  it is two diagrams: split it into its own `NN-topic.mmd` and reference it
  from the parent as `Sub[[see 03-payment.mmd]]`.
- Prefer splitting over growing. A diagram that has to be panned or zoomed to
  read has stopped being a review tool.
```

No number in the prose — there is no principled one. Mirror the same change in
`agent/skills/graph-engineering/references/diagram-selection.md`, which already
says "extract a subflow into its own `NN-topic.mmd`" but triggers it on a count.

**Tool output = the measurement.** The agent already calls `graph_validate` on
every diagram it writes, so put the number where it can be *received* rather than
imagined: `lint_mermaid` counts node definitions and subgraphs and emits a
**warning** past **more than 25 nodes or more than 5 subgraphs**.

- Warning, never an error: validation is about correctness, this is advice. A
  big but valid diagram must not read as broken.
- The threshold living in one tunable place is the point.
- The editor can show the same advisory (it already counts nodes for the Outline
  panel), so human and agent see the same signal.

### 6. Clickable `.mmd` references + a child viewport

**Goal.** Following a graph-of-graphs by hand is the missing navigation.
`Sub[[see 03-payment.mmd]]` is currently decorative — Mermaid has no cross-file
link, and clicking a node just jumps the editor to its source line.

**Agreed scope: do the clickable references alone first.** Click a reference and
open that file in a tab. Small, delivers the navigation, and tells you whether
the inset earns the viewer refactor. The child viewport is a follow-up.

**Design decisions taken (after review), for the follow-up:**

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
referenced file (tab first; later the child pane), else falls back to today's
jump-to-source.

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
  permissions are ever computed. The editor checks the agent list first and
  blocks with a clear message.
- The bridge remembers each project's diagrams directory in
  `~/.local/state/opencode-mermaid/projects.json` (an empty directory can't be
  detected).
- `AGENTS.md` in this repo was unwired and deleted on purpose: it was the
  dogfooding instance of the generator and carried no other content.
- Re-running the awareness wire-up is needed after changing `conventions_block`,
  since the generated text is written into projects.
- The editor's stall notice fires after 45s with no new content. `contentKey`
  counts text length and tool *names*, so a long silent read/think inside a turn
  can trip it while the agent is working normally — seen once while probing item
  2. If it becomes annoying, the fix is a longer `stallMs` or treating an
  in-flight tool call as progress.
