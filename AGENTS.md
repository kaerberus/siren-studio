# Project instructions

## `graphs/` is design intent, not documentation

The Mermaid diagrams in `graphs/` are the agreed design for how each flow should
behave. They are authored with a human in the Mermaid Studio editor. Treat them
as the reference, not as a description of what the code happens to do.

- **Before implementing or changing a flow, read the relevant `graphs/*.mmd`.**
- Read its sibling `*.gaps.md` ledger as well. Open questions there are
  *unresolved decisions* — raise them, do not invent an answer.
- **Never edit anything under `graphs/` as part of a coding task.** Diagrams are
  changed deliberately, with the human, by the `graph-engineer` agent. If a graph
  is wrong, say so and stop; do not quietly correct it.
- **If your implementation diverges from the graph, say so explicitly.** A
  mismatch is a design change that needs a decision, not something to smooth
  over. This is the whole point of keeping the graph: it is a claim about the
  system, and it should be falsifiable.
- Prefer the graph's vocabulary when naming things in code — the node labels and
  state names are the shared language between the design and the implementation.
