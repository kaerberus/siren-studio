# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A solo developer who runs OpenCode locally and is modeling their own system.
They work in one project at a time, with the coding agents they already use, and
they want the diagrams to stay true to the code without maintaining a second
authority by hand. They are comfortable in a terminal and with the repo
checkout, but the diagram loop itself is visual: look at the graph, point at
what is wrong, adjust it with an agent.

## Product Purpose

Siren Studio is a local, web-based Mermaid editor with a live graph viewer and an
OpenCode "Graph Engineer" agent reachable from the editor, for modeling systems
and finding design gaps.

The graph is the agreed **design intent**. The developer and the agent settle it
in the editor; code is written against it; when reality drifts, the agent updates
the graph deliberately, with the developer's approval. Success means the diagram
and the code stay in step, and the gaps the diagram exposes are found and
resolved rather than discovered later in production.

## Positioning

The graph is treated as durable shared design intent between one developer and
their coding agent — not as a diagram file that happens to sit in the repo, and
not as a chat sidebar bolted onto an editor. The mechanism a neighboring product
could not truthfully copy is the pairing of a purpose-built look → point → adjust
editor loop with an agent whose write authority is fenced to diagrams (by file
extension, with shell and the blocking question tool denied), plus the
`AGENTS.md` awareness wiring that makes ordinary coding agents read the graph
before implementing a flow. It runs offline with no Node, bundler, or build step:
both Mermaid and CodeMirror are vendored.

## Operating Context

- The OpenCode service is already running; the bridge discovers it and proxies it.
- The editor opens on a **project root**, which is the OpenCode session Location
  for that work, so diagram paths read the same for the developer and the agent.
- Diagrams live in a directory inside the root, default `graphs/`; the per-project
  choice is remembered in `~/.local/state/opencode-mermaid/projects.json`.
- The shared state is on disk: the agent edits `*.mmd` files (and `*.gaps.md`
  ledgers), the editor live-reloads them. The editor is the only surface for graph
  work because the graph is a visual artifact.
- Agent awareness is delivered by two generated `AGENTS.md` files (root pointer,
  nested diagram conventions), wrapped in replaceable markers so user text
  survives.
- A `*.gaps.md` ledger sits beside each diagram and holds the open design-gap
  questions.
- Development and testing happen from the repo checkout: `python3 install-agent.py`
  installs the global agent, skill and plugin; `python3 start.py` launches;
  `tests/` holds the dev suites.

## Capabilities and Constraints

- Two processes, one shared filesystem: a Python **standard-library-only** bridge
  (`bridge/server.py`) on `127.0.0.1`, and OpenCode itself. The browser never
  talks to OpenCode directly — the bridge keeps auth server-side.
- The bridge binds to loopback only and has no authentication of its own; it is a
  local, single-user tool, not a hardened service. It proxies OpenCode with the
  developer's credentials, so it must stay on loopback.
- No code generation from graphs, and none planned: graphs are coarse, and codegen
  from a coarse model gets ugly fast. The graph seeds the agent; it is not a
  compiler input.
- CodeMirror 5 and the Mermaid UMD build are pinned and committed because the
  target machine has no Node runtime.
- The `graph-engineer` agent may edit `*.mmd` and `*.gaps.md` and nothing else;
  `shell` and `question` are denied per-agent. This is guardrails against
  accidental changes, not a sandbox against a hostile agent.
- The plugin exposes exactly `graph_validate` and `graph_focus`; the file
  list/read/write wrappers were deliberately removed.
- The agent is pinned to `deepseek/deepseek-flash` in its frontmatter; the editor's
  model picker can override per session.
- Sessions are location-scoped: switching workspace starts a new agent session.
- The outline/selection mapping is regex-based and may miss exotic Mermaid syntax.
- Deliberately undecided: no license or distribution package exists yet (see
  Brand Commitments).

## Brand Commitments

- **Product name: Siren Studio.** Confirmed by the developer as the durable,
  binding name for future work. The repository directory remains
  `opencode-mermaid`; the product name is now propagated across the README,
  `start.py` docstring, UI, browser title, bridge awareness text, agent plugin
  and dev docs.
- The companion agent's name is **Graph Engineer**.
- Binding framing the developer has used: the graph is *design intent*; the loop
  is *look → point → adjust*; the graph is *the spec* the developer and agent
  agree on.

## Evidence on Hand

- `README.md` — the product narrative and full feature description.
- `docs/architecture.md` — process model, data flows, endpoint table, permissions,
  and known limitations.
- `docs/TODO.md` — handoff notes; the tracked work list is done apart from a
  deferred child-viewport item.
- `example-graphs/*.mmd` and `example-graphs/*.gaps.md` — worked example diagrams
  and ledgers, shipped as reference (the editor's diagrams directory, `graphs/`,
  is local state and is not committed).
- `tests/` — seven Node + jsdom dev suites (about 250 checks) that guard specific
  past regressions; `tests/README.md` documents how to run them.
- `agent/`, `agent/skills/graph-engineering/`, `agent/plugins/graph-tools.js` and
  `install-agent.py` — the agent, its skill references and its install path.

Absences future work must not fabricate: there are no testimonials, customers,
press, benchmarks, or user-research findings. There is no `LICENSE` file and no
published package, even though the developer intends to publish as open source.

## Product Principles

1. **The graph is the agreement.** It is design intent both parties can see and
   edit, not documentation generated after the fact.
2. **The developer approves every change to intent.** The agent proposes and
   updates deliberately; it does not silently redefine the model.
3. **The loop is visual.** Work happens in the editor, on the diagram — look,
   point, adjust — because the graph is a visual artifact.
4. **Local and offline by default.** Stdlib Python, vendored assets, loopback
   only, no build step; it runs on the developer's machine without a toolchain.
5. **Restraint is a feature.** No codegen, no tool bloat, diagrams-only write
   authority — narrow, legible mechanisms over general ones.

## Accessibility & Inclusion

No product-specific accessibility standard or user need has been established.
The editor does ship keyboard shortcuts, dark and light themes, and zoom/pan
driving the SVG `viewBox` so magnification stays vector-crisp.
