# TODO — next steps and handoff

Written 2026-09-28 to survive a context compaction. Read `README.md` and
`docs/architecture.md` first; this file only holds what they don't.

**Status: the list is done.** The only outstanding piece is the child viewport
deferred under item 6.

## Running it

```sh
python3 install-agent.py          # agent + skill + plugin into ~/.config/opencode
python3 start.py                  # reopens the last project you used
python3 start.py --project ~/code/some-project
python3 start.py --checkout       # force this repo instead
```

- Editor: <http://127.0.0.1:8777/>. The bridge must be running; OpenCode must be
  running for the chat to work.
- Tests: `tests/bootstrap.sh` once, then `tests/run.sh` — it starts an isolated
  bridge on 8788 against a throwaway workspace. See `tests/README.md`.
- `opencode service restart` is required after **plugin** changes (local plugin
  files are cached in the running server) and after **agent permission** changes:
  the tool catalog is snapshotted per service process. Measured, not inferred — a
  four-hour-old service still offered a tool the agent's frontmatter had just
  denied, while a freshly started one did not. An agent's *prompt* is re-read per
  turn, so prose edits do land live; only its tool surface goes stale. Skills
  reload automatically.
- If the bridge was started from inside an agent's shell, restarting the OpenCode
  service kills it. Starting it from your own terminal survives that.

## The work

### 1. ~~Move the dev test suites into the repo~~ — DONE

Now in `tests/`. `tests/bootstrap.sh` fetches Node + jsdom into `tests/.node`
and `tests/node_modules` (both gitignored); `tests/run.sh` starts an isolated
bridge on port 8788 against `/tmp/opencode/mermaid-tests/workspace`, runs all
seven suites (241 checks), and tears the bridge down.

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

### 3. ~~Collapse attachments in the chat transcript~~ — DONE

`buildPrompt` inlines the diagram and ledger as text, so the stored user message
is the question plus two whole files. The transcript now splits that apart:
`splitPrompt` in `agent.js` returns `{ question, attachments }`, and the user
bubble renders the question normally with the files folded into a collapsed
`<details>` reading *attached: a.mmd, a.gaps.md*. Each file keeps its own heading
(`diagram · a.mmd`) and its source unfenced.

Render-only — the model still receives exactly what it did before, including
unsaved buffer edits, which is why we inline rather than use file attachments.

The markers live in one place: `attachmentHeader(kind, path)` is what
`buildPrompt` writes and `parseAttachmentHeader(line)` is its inverse, so the
builder and the renderer cannot drift. The `untitled` / `none` fallbacks are
part of the round trip.

Checked in `smoke.mjs`: the header round-trips for both kinds and both fallbacks,
`splitPrompt` unfences the bodies and leaves a plain message alone, and the DOM
renders a collapsed `<details>` that names both files while the question stays
outside the fold.

### 4. ~~Resizeable agent panel~~ — DONE

`.body`'s grid is now four tracks — `sidebar | workbench | splitter | agent` —
with `--splitter-w` shared by both handles, and an `.agent-splitter` between the
workbench and the panel that rewrites `--agent-w`.

Clamps: 280px minimum, 720px maximum, and never less than 420px left for the
workbench. The third matters — on a small window the absolute maximum never
binds and the workbench floor is what does, so all four regimes are tested
(free, absolute max, workbench floor, minimum). `.app.resizing` drops the
`grid-template-columns` transition during a drag so the divider tracks the
pointer instead of easing toward it, and the handle goes `pointer-events: none`
while `agent-hidden`, so a collapsed panel cannot be grabbed.

Worth a look in a real browser: nothing is connected to the review pane, and
jsdom does no layout, so the checks cover the drag arithmetic and the CSS
parsing into the expected rules, not the rendered proportions.

### 5. ~~Conventions wording + a size advisory~~ — DONE

Landed as described below. The thresholds are exact: 25 nodes and 5 subgraphs
stay silent, 26 and 6 warn, and the advisory is a warning even when the diagram
is otherwise valid. Also fixed the two copies of the old `~20 nodes` rule that
this item missed — `graph-engineer.md` and `codebase-to-flow.md` — while doing
item 2.

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

### 6. Clickable `.mmd` references — DONE (the child viewport is deferred)

**Goal.** Following a graph-of-graphs by hand was the missing navigation.
`Sub[[see 03-payment.mmd]]` was decorative — Mermaid has no cross-file link, and
clicking a node just jumped the editor to its source line.

**Done: the clickable references alone.** After every render, `markNodeLinks`
(`viewer.js`) asks `resolveDiagramRef` (`app.js`) to resolve each node's label to
a path. Matches get a `.node-link` class and `data-link`; the click handler opens
that file in a tab, and only falls back to jump-to-source when there is no link.

- **Only real files resolve.** A reference the agent has not written yet stays a
  plain node, so a graph it is about to write does not look clickable already.
- **Resolution is by basename**, preferring a sibling of the open diagram, then
  matching case-insensitively anywhere in the diagrams directory. An explicit
  relative path (`sub/03-payment.mmd`) resolves only if it exists. Labels are
  prose, so it scans label tokens for one ending in `.mmd`/`.mermaid` rather than
  matching the whole string.
- **Discoverability:** a dotted underline on the label plus a pointer cursor, so
  the link is visible before you hover, and a glow on the node while hovering.
- **Cycles are a non-issue in the tab model:** `openFile` just activates a tab
  that is already open, so a self-reference is a no-op.

**Deferred: the child viewport.** The design below is settled for when it earns
the viewer refactor; the clickable references were the cheap way to find out
whether it does.

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

### 7. ~~The stall notice fired on a wait, not a hang~~ — DONE

The turn that stalled while probing item 2 ended with `tools=['question:running']`
— the agent had asked *me* a question and was waiting on the answer. The editor
watched the message sit still for 45s and offered Retry/Stop. Two causes, both
fixed in `agent.js`:

- `contentKey` counted only `text` parts and tool *names*, so streamed
  **reasoning** — most of a long turn — was invisible to the timer. It now
  covers text, reasoning, and each tool's status plus output length.
- A tool in flight is a wait, not a hang, so `turnDecision` takes `running` and
  never stalls while one is. Emptiness moved to its own signal (`visible`): a
  reasoning-only completion still reads as "no output", because the reader saw
  nothing.

The notice copy is unchanged ("No output from X yet"); with the fix it means what
it says. The threshold stays 45s, which now means "the session went quiet".

Related, in `app.js`: **Send is no longer disabled while a turn runs.** Sending
mid-turn steers it (`delivery: 'steer'`), and an agent waiting on a question would
otherwise be unanswerable by click. The hint switches to "Ctrl+Enter to steer",
and Stop is the affordance for a busy turn.

### 8. ~~Tell the agent how links and splits actually work~~ — DONE

It knew the rule (split by concern) and one syntax example, and nothing about the
mechanism or the obligations.

**Tooling — the half that matters.** `graph_validate` now resolves the diagram
references in a source's node labels against the diagrams directory and warns
about any that go nowhere, plus a missing sibling `.gaps.md` when validating by
path. It mirrors the editor: an explicit relative path must exist, a bare
filename matches anywhere in the directory. Detection is label-only, so a `.mmd`
name in a comment, an edge label or a `classDef` is ignored — the editor would
not link it either, and saying otherwise would teach the wrong thing.

A `click` directive naming a diagram gets its own message, because that is the
mistake actually observed: an agent that had not been told the convention wrote
`click Handoff "graphs/02-render-pipeline.mmd"` and recorded "which convention
does the editor use" as an open question in the ledger. Staying silent there
would have let it believe the link worked, so the warning names the fix
(`Sub[[see x.mmd]]`).

**Prose.** `conventions_block()` gained "References between diagrams" and
"Splitting a diagram": the link contract, and the five things a split owes (a
free `NN`; the child's own `.gaps.md`; validating the child; replacing the moved
detail rather than duplicating it; recording the decision). Mirrored in
`diagram-selection.md`, `vocabulary.md` (the `[[ ]]` shape now says it is a link)
and `graph-engineer.md`.

Projects need the awareness wire-up re-run to pick up the new block.

### 9. ~~README pass~~ — DONE

Read through and corrected in place, rather than patching from the list above:

- `## Editor` — clicking a node that names a diagram **opens that file**; jumping
  to source is the fallback. New **Cross-file links** bullet covering what makes a
  link: the extension, an existing file, a node label, basename resolution.
- The **agent-panel divider** is documented, and `Ctrl+Enter` now reads "or steer
  a running one", with a **Steering** paragraph.
- **Stuck turns** describes the real semantics: *nothing* changed for 45s.
  Thinking and running tools count as progress.
- **Permissions** — the `question` deny and why; the section heading no longer
  implies "no shell" is the whole story.
- **Validation round-trip** — the warnings, not just the parse verdict.
- The restart caveat now covers **agent permissions**, not only plugin files.
- New **## Tests** section; `tests/` added to the layout tree.
- Roadmap names the deferred child viewport.

`tests/README.md` gained the prompt-tool note, and item 1's check count was stale
(175 → 222).

### 10. ~~Hide `question` from the graph engineer; advertise steering~~ — DONE

`question` is a real OpenCode built-in (`packages/opencode/src/tool/question.ts`):
its `execute` blocks until the user answers a multiple-choice picker. The editor
has no picker, so the turn waits forever — which is the stalled turn from item 7
seen from the other side. It is on by default here because `flags.client` falls
back to `"cli"`, which is in the enable-list.

`graph-engineer.md` now denies it the same way the global config denies
`graph_*`, per-agent on purpose so the TUI keeps the tool. Verified in
`permissions-e2e.py`: on a fresh server the agent searches its own Code Mode
catalog for "question" and finds nothing, while `graph.validate` still works in
the same turn as the positive control. **The running service needs a restart to
pick it up** (see "Running it").

Also: Send is no longer disabled while a turn runs, and the composer says so —
placeholder *"Model is running — send a message to steer it…"*, hint
*"Ctrl+Enter to steer"*. `composerCopy(busy, idlePlaceholder)` holds both states
and is checked in smoke.

### 11. ~~Rescan folder, and stop the launcher swapping projects under you~~ — DONE

All three came out of the same confusion: wipe a project, reopen the editor, and
get shown a *different* project's files.

**The rescan button.** `#btn-refresh` was wired to `refreshTree()` with no
feedback, so next to a path it read as "rescan or change this folder" while
visibly doing neither. It is now *Rescan folder* and does a real resync: re-read
the tree, every **clean** buffer (dirty ones are left alone), and the open
diagram's ledger, then say what changed. It still deliberately does not switch
project — that is `Open project…`, and a rescan that teleports you elsewhere
would be the bug, not the fix.

**Name the folder.** `applyWorkspaceLabels()` sets the topbar label, the
file-tree head, the browser tab title, and the head's tooltip (absolute path).
It runs at boot, on a UI project switch, and on `workspace-changed` — which
previously updated no label at all.

**Reopen where you left off.** A bare `start.py` used to hard-default to this
checkout, so a restart silently moved the editor to a different project and its
files looked like a wipe that had not taken. `resolve_project()` now reopens the
last project from `projects.json`'s `at` stamp, falling back to the checkout.
Guards: temp paths are never considered (the suites start bridges against
throwaway workspaces and one must never become the default), a project that is
gone is skipped, `--project` wins, and `--checkout` forces the repo. The banner
prints which project it picked and why.

**The one behaviour change:** a bare `python3 start.py` no longer guarantees this
checkout. In steady use it reopens whatever you last had open — including the
repo — and the banner always says which one.

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
